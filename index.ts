import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Bảng giá đất — PHẢI khớp với cột giá (vị trí thứ 4) trong RAW_TILES của game-data.js
const TILE_PRICES = [
  250, 350, 120, 250, 180, 0, 350, 180, 250, 350,
  0, 350, 180, 250, 250, 350, 0, 180, 400, 120,
  0, 350, 250, 120, 250, 400, 120, 180, 350, 250,
  0, 400, 180, 400, 180, 250, 0, 250, 250, 350,
];

const MAX_RETRIES = 8; // số lần thử lại tối đa khi đụng version (race condition)

class AppError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function jsonError(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function advanceTurn(state: any) {
  const n = state.turnOrder.length;
  // Kiểm tra còn ai active không — nếu không thì kết thúc game luôn
  const anyActive = state.turnOrder.some((id: number) => state.players[id].status === "active");
  if (!anyActive) { state.gameEnded = true; return; }

  let pos = state.currentTurnPos;
  let tries = 0;
  do {
    pos = (pos + 1) % n;
    tries++;
  } while (state.players[state.turnOrder[pos]].status !== "active" && tries < n);
  state.currentTurnPos = pos;
  state.turnStartedAt = Date.now(); // timestamp để client đếm ngược 10s roll
}

// ── Di chuyển player theo `sum` ô + xử lý ô đáp xuống (thuế/nhà nước/tù/đất) ──
// Dùng chung cho cả roll bình thường VÀ roll-đôi-trong-tù (vì luật thật: đổ đôi trong tù
// thì được ra tù NGAY và đi tiếp đúng số điểm vừa đổ, đáp ô nào xử lý ô đó bình thường).
// `events` là mảng các dòng text để hiện banner giữa bàn cho TẤT CẢ người xem.
function moveAndResolve(state: any, player: any, playerId: number, sum: number, events: string[]) {
  const TOTAL_TILES = state.tiles.length;
  const PASS_START_BONUS = 200; // Khớp với game-data.js
  const oldPos = player.position;
  const newPos = (oldPos + sum) % TOTAL_TILES;

  // Tìm đúng vị trí ô "Xuất phát" thật trong bàn cờ (không phải lúc nào cũng là index 0!)
  const startIdx = state.tiles.findIndex((t: any) => t.type === "start");

  state.pendingBuyTile = null;

  // Kiểm tra xem đường đi từ oldPos+1 đến oldPos+sum có đi NGANG QUA hoặc ĐÁP ĐÚNG ô Xuất phát không
  let passedStart = false;
  if (startIdx >= 0) {
    for (let k = 1; k <= sum; k++) {
      if ((oldPos + k) % TOTAL_TILES === startIdx) { passedStart = true; break; }
    }
  }

  if (passedStart) {
    player.money += PASS_START_BONUS;
    const msg = `${player.name} đi qua Xuất Phát, +${PASS_START_BONUS}$`;
    state.log.unshift(msg);
    events.push(`🏁 ${msg}`);
  }
  player.position = newPos;

  const tile = state.tiles[newPos];

  if (tile.type === "tax") {
    player.money -= 100;
    const msg = `${player.name} nộp thuế 100$`;
    state.log.unshift(msg);
    events.push(`🧾 ${msg}`);
    eliminateIfBankrupt(state, player, events);
    advanceTurn(state);
  } else if (tile.type === "state") {
    player.money -= 100;
    const msg = `${player.name} dừng tại ô ${tile.name} — nộp phí dịch vụ nhà nước 100$`;
    state.log.unshift(msg);
    events.push(`🏛️ ${msg}`);
    eliminateIfBankrupt(state, player, events);
    advanceTurn(state);
  } else if (tile.type === "jail") {
    player.jailTurns = 2;
    const msg = `${player.name} vào tù 2 lượt`;
    state.log.unshift(msg);
    events.push(`🚔 ${msg}`);
    advanceTurn(state);
  } else if (tile.type === "property") {
    const owner = tile.owner;
    if (owner === null) {
      state.pendingBuyTile = newPos;
      state.pendingBuyExpireAt = Date.now() + 15000; // 15s đếm ngược
      // TUYỆT ĐỐI KHÔNG advanceTurn ở đây — giữ lượt cho người chơi bấm Mua/Bỏ qua
    } else if (owner === playerId) {
      state.log.unshift(`${player.name} đứng trên đất của mình`);
      advanceTurn(state);
    } else {
      const baseRent = tile.rent || 0;
      const rent = baseRent * (tile.rentMultiplier || 1);
      player.money -= rent;

      let ownerReceives = rent;
      state.players.forEach((sp: any) => {
        if (sp.status === "shareholder" && sp.shareholderOf === owner && sp.shareholderEquity > 0) {
          const cut = Math.round(rent * sp.shareholderEquity);
          sp.money += cut;
          ownerReceives -= cut;
          state.log.unshift(`💹 ${sp.name} nhận cổ tức ${cut}$`);
        }
      });
      state.players[owner].money += ownerReceives;
      const msg = `${player.name} trả ${rent}$ tiền thuê cho ${state.players[owner].name}`;
      state.log.unshift(msg);
      events.push(`💸 ${msg}`);
      eliminateIfBankrupt(state, player, events);
      advanceTurn(state);
    }
  } else {
    advanceTurn(state);
  }
}

// ── Tự động loại player nếu hết tiền sau khi trả thuê/rent ──
function eliminateIfBankrupt(state: any, player: any, events: string[]) {
  if (player.money > 0) return;
  player.status = "eliminated";
  // Trả toàn bộ đất về ngân hàng
  (player.properties as number[]).forEach((idx: number) => {
    state.tiles[idx].owner = null;
    state.tiles[idx].rentMultiplier = 1;
  });
  player.properties = [];
  const msg = `💀 ${player.name} phá sản và bị loại khỏi game!`;
  state.log.unshift(msg);
  events.push(`💀 ${msg}`);
}

// ── Toàn bộ logic validate + áp dụng 1 action lên state ──
// Ném AppError nếu action không hợp lệ. Trả về { dice, events }.
function applyAction(state: any, playerId: number, action: string): { dice: [number, number] | null; events: string[] } {
  // Auto-skip nếu current player đã bị loại (admin loại giữa chừng khi đang tới lượt họ)
  {
    let safety = 0;
    while (
      state.players[state.turnOrder[state.currentTurnPos]]?.status !== "active" &&
      safety < state.turnOrder.length
    ) {
      advanceTurn(state);
      safety++;
    }
  }

  const currentPlayerId = state.turnOrder[state.currentTurnPos];
  if (currentPlayerId !== playerId) {
    throw new AppError("Không phải lượt của bạn", 403);
  }

  const player = state.players[playerId];
  if (player.status !== "active") {
    throw new AppError("Bạn không còn trong game", 403);
  }

  if (state.pendingBuyTile === undefined) state.pendingBuyTile = null;

  let dice: [number, number] | null = null;
  const events: string[] = [];

  if (action === "roll") {
    if (player.jailTurns > 0) {
      throw new AppError("Bạn đang ở trong tù, hãy dùng action jail-roll / jail-pay / jail-wait", 400);
    }
    if (state.pendingBuyTile !== null) {
      throw new AppError("Còn đang chờ quyết định mua đất, chưa thể roll", 400);
    }

    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);
    dice = [d1, d2];
    state.lastDice = dice;
    state.diceRollId = Date.now() + Math.random();
    state.lastMovedPlayerId = playerId;

    moveAndResolve(state, player, playerId, d1 + d2, events);
  } else if (action === "jail-roll") {
    if (player.jailTurns <= 0) throw new AppError("Bạn không ở trong tù", 400);

    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);
    dice = [d1, d2];

    state.lastDice = dice;
    state.diceRollId = Date.now() + Math.random();
    state.lastMovedPlayerId = playerId;

    if (d1 === d2) {
      player.jailTurns = 0;
      const msg = `${player.name} đổ đôi (${d1},${d2}) — RA TÙ ngay, đi tiếp ${d1 + d2} bước!`;
      state.log.unshift(msg);
      events.push(`🔓 ${msg}`);
      // Đúng luật: ra tù bằng đôi thì ĐI TIẾP theo đúng số điểm vừa đổ, đáp ô nào xử lý ô đó
      moveAndResolve(state, player, playerId, d1 + d2, events);
    } else {
      player.jailTurns -= 1;
      const msg = `${player.name} không đổ đôi, còn ${player.jailTurns} lượt trong tù.`;
      state.log.unshift(msg);
      events.push(`🚔 ${msg}`);
      advanceTurn(state);
    }
  } else if (action === "jail-pay") {
    if (player.jailTurns <= 0) throw new AppError("Bạn không ở trong tù", 400);
    if (player.money < 200) throw new AppError("Không đủ tiền để trả 200$", 400);

    player.money -= 200;
    player.jailTurns = 0;
    const msg = `${player.name} trả 200$ để ra tù.`;
    state.log.unshift(msg);
    events.push(`🔓 ${msg}`);
    advanceTurn(state);
  } else if (action === "jail-wait") {
    if (player.jailTurns <= 0) throw new AppError("Bạn không ở trong tù", 400);

    player.jailTurns -= 1;
    state.log.unshift(`${player.name} chờ thêm 1 lượt trong tù.`);
    advanceTurn(state);
  } else if (action === "buy-yes") {
    const idx = state.pendingBuyTile;
    if (idx === null || idx === undefined) throw new AppError("Không có đất nào đang chờ mua", 400);

    const tile = state.tiles[idx];
    if (tile.owner !== null) throw new AppError("Đất đã có chủ", 400);

    const price = TILE_PRICES[idx] || 0;
    if (player.money < price) throw new AppError("Không đủ tiền mua đất", 400);

    player.money -= price;
    tile.owner = playerId;
    player.properties.push(idx);
    const msg = `${player.name} đã mua ${tile.name} giá ${price.toLocaleString()}$.`;
    state.log.unshift(msg);
    events.push(`🏠 ${msg}`);
    state.pendingBuyTile = null;
    state.pendingBuyExpireAt = null;
    advanceTurn(state);
  } else if (action === "buy-no") {
    const idx = state.pendingBuyTile;
    if (idx === null || idx === undefined) throw new AppError("Không có đất nào đang chờ mua", 400);

    state.log.unshift(`${player.name} không mua ${state.tiles[idx].name}.`);
    state.pendingBuyTile = null;
    state.pendingBuyExpireAt = null;
    advanceTurn(state);
  } else if (action === "skip-turn") {
    // Hết 10s không roll → mất lượt tự động
    state.log.unshift(`⏱ ${player.name} hết thời gian, mất lượt.`);
    events.push(`⏱ ${player.name} hết thời gian, mất lượt.`);
    advanceTurn(state);
  } else {
    throw new AppError(`Action không hợp lệ: ${action}`, 400);
  }

  if (state.log.length > 50) state.log = state.log.slice(0, 50);

  // Lưu events vào state để MỌI client (qua Realtime) đều hiện được banner giữa bàn,
  // không chỉ riêng người vừa thao tác.
  if (events.length > 0) {
    state.lastEvents = events;
    state.lastEventId = Date.now() + Math.random();
  }

  return { dice, events };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { roomId, playerId, action = "roll" } = await req.json();

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ── Vòng lặp optimistic-lock: đọc state mới nhất + version, áp dụng action,
    //    ghi đè CHỈ KHI version chưa đổi. Nếu có request khác chen ngang và ghi
    //    trước (version đã tăng) → đọc lại bản mới nhất và làm lại từ đầu. ──
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const { data, error } = await supabase
        .from("games")
        .select("state, version")
        .eq("id", roomId)
        .single();

      if (error) throw error;

      const state = data.state;
      const version = data.version ?? 0;

      let result: { dice: [number, number] | null; events: string[] };
      try {
        result = applyAction(state, playerId, action);
      } catch (e: any) {
        if (e instanceof AppError) return jsonError(e.message, e.status);
        throw e;
      }

      const { data: updated, error: updateError } = await supabase
        .from("games")
        .update({ state, version: version + 1 })
        .eq("id", roomId)
        .eq("version", version)
        .select("version");

      if (updateError) throw updateError;

      if (updated && updated.length > 0) {
        return new Response(
          JSON.stringify({ ok: true, dice: result.dice, events: result.events, state }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      // Bị đụng version → đọc lại từ đầu, thử lại (không trả lỗi cho user)
    }

    return jsonError("Server đang bận do nhiều người cùng thao tác, hãy thử lại", 409);
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
