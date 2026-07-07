/* ============================================================
   supabase-client.js — kết nối & đồng bộ state dùng chung
   ============================================================ */
const SUPABASE_URL = "https://rokrtskepndjuowxmhld.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJva3J0c2tlcG5kanVvd3htaGxkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2MzAzNTksImV4cCI6MjA5ODIwNjM1OX0.zMdDWZD2Cjgo9H8CjkqxKozFAq8qf3_BlTHe1oP1FZs";
const GAME_ID = "00000000-0000-0000-0000-000000000001";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function loadState(){
  const {data, error} = await supabaseClient.from("games").select("state").eq("id", GAME_ID).single();
  if(error){ console.error("loadState error", error); return null; }
  return data.state;
}

async function saveState(state){
  const {error} = await supabaseClient.from("games").update({state, updated_at:new Date().toISOString()}).eq("id", GAME_ID);
  if(error){ console.error("saveState error", error); alert("Lỗi lưu dữ liệu: " + error.message); }
}

// Đọc-sửa-ghi: CHỈ dùng cho thao tác KHÔNG ảnh hưởng lượt chơi (join phòng, đổi tên, admin...).
// Trả về state mới để nơi gọi cập nhật lại biến state toàn cục.
// Mọi action liên quan lượt chơi (roll/jail/mua đất) đã chuyển qua gameAction() (Edge Function
// có validate quyền + optimistic lock chống ghi đè).
//
// QUAN TRỌNG — ĐÃ SỬA: bản trước đây saveState() ghi thẳng, KHÔNG check cột "version", nên khi
// 2 nơi cùng ghi gần như đồng thời (ví dụ: MC bấm Kick đúng lúc admin.html đang tự động ghi
// elapsedSec mỗi giây trong tick()) thì ai ghi SAU sẽ xoá mất thay đổi của người ghi TRƯỚC — dù
// thao tác trước đó (như Kick) đã "thành công" một cách âm thầm rồi bị đè mất, khiến phải bấm
// lại nhiều lần mới "ăn". Giờ dùng ĐÚNG cơ chế optimistic-lock + retry y hệt Edge Function
// index.ts (đọc kèm version, ghi có điều kiện .eq("version", version), đụng version thì đọc lại
// từ đầu và làm lại — không đời nào ghi đè mất thao tác của người khác nữa).
async function mutateState(mutatorFn, maxRetries = 8){
  for(let attempt = 0; attempt < maxRetries; attempt++){
    const {data, error} = await supabaseClient.from("games").select("state, version").eq("id", GAME_ID).single();
    if(error){ console.error("mutateState (đọc) lỗi", error); return null; }

    const state = data.state;
    const version = data.version ?? 0;
    mutatorFn(state);

    const {data: updated, error: updateError} = await supabaseClient
      .from("games")
      .update({ state, version: version + 1, updated_at: new Date().toISOString() })
      .eq("id", GAME_ID)
      .eq("version", version)
      .select("version");

    if(updateError){
      console.error("mutateState (ghi) lỗi", updateError);
      alert("Lỗi lưu dữ liệu: " + updateError.message);
      return null;
    }
    if(updated && updated.length > 0){
      return state; // ghi thành công, không bị ai đụng version
    }
    // Bị đụng version (có nơi khác vừa ghi trước) → đọc lại từ đầu, thử lại — KHÔNG báo lỗi cho
    // người dùng, retry vài lần gần như tức thì là xong, không cần bấm lại nút.
  }
  alert("Server đang bận do nhiều nơi cùng ghi dữ liệu cùng lúc, hãy thử lại thao tác.");
  return null;
}

function subscribeToChanges(onChange){
  return supabaseClient
    .channel("game-changes")
    .on("postgres_changes", {event:"UPDATE", schema:"public", table:"games", filter:`id=eq.${GAME_ID}`}, (payload)=>{
      onChange(payload.new.state);
    })
    .subscribe();
}

// Gọi Edge Function cho mọi action có liên quan đến lượt chơi (roll, jail, mua đất...).
// Server tự đọc state mới nhất, validate đúng lượt + đủ điều kiện, tính toán, rồi ghi đè 1 lần.
async function gameAction(roomId, playerId, action, extra) {
  const res = await fetch(
    `${SUPABASE_URL}/functions/v1/roll-dice`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ roomId, playerId, action, ...(extra || {}) }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Lỗi server");
  return data;
}

// Giữ lại để tương thích — roll lượt thường, tương đương gameAction(..., "roll")
async function rollDice(roomId, playerId) {
  return gameAction(roomId, playerId, "roll");
}

/* ============================================================
   PRESENCE — biết ai đang THỰC SỰ mở kết nối tới ván này.
   ------------------------------------------------------------
   QUAN TRỌNG: KHÔNG dùng mutateState() để làm "heartbeat" (ví dụ tự ghi
   player.lastPing mỗi vài giây) — mutateState()/saveState() ở trên KHÔNG hề
   check cột "version" (chỉ Edge Function roll-dice mới có optimistic-lock
   thật). Nếu heartbeat ghi qua mutateState() lặp lại liên tục, có rủi ro
   THẬT: heartbeat đọc state cũ → 1 hành động roll/mua đất khác vừa ghi state
   mới qua Edge Function → heartbeat ghi tiếp bản CŨ nó vừa đọc → xoá mất
   hành động roll/mua đất đó. Presence dưới đây KHÔNG đụng vào bảng `games`
   chút nào nên tránh hẳn được rủi ro trên, và phát hiện mất kết nối chính
   xác hơn (dựa vào việc socket có đang mở hay không, không phải đoán qua
   timeout của heartbeat tự ghi).

   AN TOÀN TUYỆT ĐỐI VỚI GAME GỐC: đây là tính năng PHỤ, chỉ để hiển thị
   online/offline. TOÀN BỘ code dưới đây được bọc try/catch — nếu Realtime
   Presence API lỗi/ném exception vì bất kỳ lý do gì (mạng, phiên bản thư
   viện, channel chưa join kịp...), lỗi đó CHỈ bị log ra console và bị nuốt
   tại chỗ, KHÔNG bao giờ được phép lan ra ngoài làm gián đoạn phần script
   gọi nó — vì loadState/saveState/mutateState/gameAction/rollDice ở trên
   (toàn bộ luồng chơi game thật) phải luôn chạy được bất kể Presence có
   hoạt động hay không.
   ============================================================ */
let presenceChannel = null;
let presenceSubscribed = false;
let myTrackedPlayerId = null;
const presenceListeners = []; // các callback đăng ký qua subscribeOnlinePlayers(), gọi lại mỗi khi có sync mới

function computeOnlineIds(){
  if(!presenceChannel) return new Set();
  const raw = presenceChannel.presenceState(); // { channelKey: [{playerId, at}, ...] }
  const ids = new Set();
  Object.values(raw).forEach(entries=>{
    entries.forEach(e=>{ if(e && e.playerId !== undefined && e.playerId !== null) ids.add(e.playerId); });
  });
  return ids;
}

try{
  presenceChannel = supabaseClient.channel(`presence-${GAME_ID}`);
  // QUAN TRỌNG — ĐÚNG THỨ TỰ CHUẨN CỦA SUPABASE: channel.on(...) PHẢI được đăng ký TRƯỚC
  // channel.subscribe(). Bản trước đó gọi ngược lại (subscribe() trước, on() sau, xem
  // ensurePresenceSubscribed() bên dưới) khiến sự kiện "sync" không được nhận đúng cách —
  // đây là nguyên nhân admin cứ hiện mãi "Chưa rõ", và các máy người chơi nhận sai dữ liệu
  // online/offline làm bỏ lượt sai (tưởng offline trong khi vẫn đang chơi bình thường).
  presenceChannel.on("presence", {event:"sync"}, ()=>{
    try{
      const ids = computeOnlineIds();
      presenceListeners.forEach(cb=>{
        try{ cb(ids); }catch(e){ console.error("[presence] Lỗi trong 1 listener (bỏ qua):", e); }
      });
    }catch(e){ console.error("[presence] Lỗi khi tính danh sách online (bỏ qua):", e); }
  });
}catch(e){ console.error("[presence] Không tạo được channel — tính năng online/offline sẽ không hoạt động, KHÔNG ảnh hưởng gì tới việc chơi game:", e); presenceChannel = null; }

function ensurePresenceSubscribed(){
  try{
    if(presenceSubscribed || !presenceChannel) return;
    presenceSubscribed = true;
    presenceChannel.subscribe(async (status)=>{
      try{
        if(status === "SUBSCRIBED" && myTrackedPlayerId !== null){
          await presenceChannel.track({ playerId: myTrackedPlayerId, at: Date.now() });
        }
      }catch(e){ console.error("[presence] Lỗi khi track (bỏ qua):", e); }
    });
  }catch(e){ console.error("[presence] Lỗi khi subscribe (bỏ qua):", e); }
}

// Gọi từ index.html NGAY SAU KHI biết chắc mình là player nào (claim slot / tự rejoin).
// An toàn khi gọi lại nhiều lần (ví dụ rejoin) — track() ghi đè presence cũ của chính mình.
// Luôn nuốt lỗi tại chỗ — không bao giờ throw ra ngoài, để không ảnh hưởng luồng claim-slot/rejoin.
async function trackMyPresence(playerId){
  try{
    myTrackedPlayerId = playerId;
    ensurePresenceSubscribed();
    if(presenceChannel && presenceChannel.state === "joined"){
      await presenceChannel.track({ playerId, at: Date.now() });
    }
    // Nếu channel chưa join xong thì callback trong ensurePresenceSubscribed() ở trên sẽ tự
    // track() ngay khi status chuyển thành "SUBSCRIBED", không cần chờ gọi lại hàm này.
  }catch(e){ console.error("[presence] Lỗi trackMyPresence (bỏ qua, không ảnh hưởng game):", e); }
}

// Gọi từ index.html (mọi client, kể cả màn hình trình chiếu) và admin.html để lấy danh sách
// playerId đang thực sự online. onChange(Set<number>) được gọi mỗi khi có người vào/rời kết nối,
// và được gọi ngay lập tức 1 lần với dữ liệu hiện có nếu channel đã join sẵn từ trước.
// Luôn nuốt lỗi tại chỗ — không bao giờ throw ra ngoài, để không ảnh hưởng phần code gọi nó.
function subscribeOnlinePlayers(onChange){
  try{
    presenceListeners.push(onChange);
    ensurePresenceSubscribed();
    if(presenceChannel && presenceChannel.state === "joined"){
      onChange(computeOnlineIds());
    }
  }catch(e){ console.error("[presence] Lỗi subscribeOnlinePlayers (bỏ qua, không ảnh hưởng game):", e); }
}
