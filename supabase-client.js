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

/* ============================================================
   ĐỒNG BỘ ĐỒNG HỒ CLIENT ↔ SERVER (clock offset)
   ------------------------------------------------------------
   VẤN ĐỀ ĐÃ SỬA: toàn bộ logic đếm ngược mua đất (pendingBuyExpireAt) và
   watchdog tự động trả tiền thuê/hết giờ (afkWatchdog, turnStartedAt...)
   trước đây dùng THẲNG Date.now() của TỪNG máy — tức là lấy giờ hệ thống
   riêng của mỗi trình duyệt. Nếu đồng hồ máy nào đó bị lệch (nhanh/chậm dù
   chỉ vài giây tới vài chục giây — rất hay gặp trên điện thoại/máy không
   bật đồng bộ giờ tự động) thì xảy ra ĐÚNG các triệu chứng đã gặp:
     - Số giây đếm ngược hiển thị nhảy loạn giữa các máy (15s/17s/45s...)
       vì mỗi máy tự lấy "còn lại = pendingBuyExpireAt - giờ máy mình".
     - Có máy đồng hồ CHẠY NHANH hơn → tưởng đã hết 15s dù mới qua 1-2s
       thật, tự ý gọi action "buy-no" (trả tiền thuê) giùm SỚM.
     - Máy đang thao tác (bấm "Mua") thì bị lỡ vì lượt đã bị máy khác (do
       đồng hồ nhanh) tự động xử lý xong trước đó → server trả lỗi
       "Không phải lượt của bạn".
   CÁCH SỬA: đo độ lệch (offset) giữa giờ máy mình và giờ SERVER (lấy từ
   header "Date" trong response HTTP của chính Supabase — không cần thêm
   endpoint nào khác), rồi CỘNG offset đó vào Date.now() mỗi khi cần lấy
   "giờ hiện tại" liên quan tới đếm ngược / watchdog. Nhờ vậy dù đồng hồ
   máy có sai lệch, mọi máy đều tính toán dựa trên cùng 1 mốc giờ THỐNG
   NHẤT (xấp xỉ giờ server), không còn bị lệch pha giữa các máy nữa.
   Dùng chung cho cả index.html LẪN admin.html vì cả 2 đều load file này.
   ============================================================ */
let clockOffsetMs = 0; // serverNow ≈ Date.now() + clockOffsetMs

// Lấy "giờ hiện tại" đã hiệu chỉnh theo server — dùng thay cho Date.now()
// ở MỌI chỗ liên quan tới pendingBuyExpireAt / turnStartedAt / gameStartedAt / watchdog.
function nowSynced(){
  return Date.now() + clockOffsetMs;
}

// Đo lệch giờ bằng 1 request HEAD nhẹ tới chính Supabase REST endpoint, đọc
// header "Date" server trả về (chuẩn HTTP, mọi server đều có). Trừ đi nửa
// round-trip-time để bù độ trễ mạng cho chính xác hơn (kiểu ước lượng NTP
// đơn giản). Luôn nuốt lỗi tại chỗ — nếu đo lỗi (mạng chập chờn...) thì giữ
// nguyên offset cũ, KHÔNG làm gián đoạn game.
async function syncClockOffset(){
  try{
    const t0 = Date.now();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      method: "HEAD",
      headers: { apikey: SUPABASE_ANON_KEY }
    });
    const t1 = Date.now();
    const dateHeader = res.headers.get("date");
    if(dateHeader){
      const serverNowAtT1 = new Date(dateHeader).getTime();
      const rtt = t1 - t0;
      // Ước lượng giờ server tại thời điểm t1 (đã bù nửa round-trip)
      const estServerNow = serverNowAtT1 + rtt/2;
      clockOffsetMs = estServerNow - t1;
    }
  }catch(e){ console.error("[clock-sync] Không đo được lệch giờ server (bỏ qua, dùng offset cũ):", e); }
}

// Đo ngay khi load trang, và đo lại định kỳ để bù trôi giờ (drift) + phòng
// trường hợp lần đo đầu tiên bị mạng chậm/lỗi.
syncClockOffset();
setInterval(syncClockOffset, 30000);

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
