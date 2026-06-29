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

// Đọc-sửa-ghi: dùng cho các thao tác KHÔNG ảnh hưởng lượt chơi (join phòng, đổi tên, admin...).
// ĐÃ SỬA: trả về state mới để nơi gọi cập nhật lại biến state toàn cục, tránh render với data cũ.
// Lưu ý: hàm này KHÔNG validate lượt/quyền — không dùng cho roll/jail/mua đất nữa, các action đó
// đã chuyển hết qua gameAction() (Edge Function, có validate + chống ghi đè race condition).
async function mutateState(mutatorFn){
  const state = await loadState();
  if(!state) return null;
  mutatorFn(state);
  await saveState(state);
  return state;
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
async function gameAction(roomId, playerId, action) {
  const res = await fetch(
    `${SUPABASE_URL}/functions/v1/roll-dice`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ roomId, playerId, action }),
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
