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
const BUY_TIMEOUT_MS = 15000; // PHẢI khớp với BUY_TIMEOUT ở index.html
const AFK_TIMEOUT_MS = 45000; // PHẢI khớp với AFK_TIMEOUT ở index.html
const DISCONNECT_SKIP_TIMEOUT_MS = 8000; // PHẢI khớp với DISCONNECT_SKIP_TIMEOUT ở index.html
// Dung sai nhỏ cho các mốc hết giờ tự động — bù phần sai số ước lượng còn sót lại của
// nowSynced() phía client (tối đa cỡ dưới 1s, xem syncClockOffset() trong supabase-client.js)
// + độ trễ mạng thật của chính request đang xử lý. KHÔNG dùng để "nới" thời gian chơi, chỉ để
// server không lỡ từ chối 1 request hợp lệ do sai số đo lường bình thường.
const TIMEOUT_GRACE_MS = 500;

// PHA LOÃNG CỔ PHẦN: khi 1 người (ownerId) đang có cổ đông ăn theo % (shareholderOf === ownerId)
// mà TỰ BỎ TIỀN RIÊNG mua thêm đất mới (không liên quan gì tới phần đất cổ đông từng góp), thì %
// của cổ đông phải giảm tương ứng theo tỷ trọng giá trị tài sản cũ/mới — nếu không, cổ đông sẽ ăn
// mãi mãi % cố định trên cả phần tài sản mà họ không hề đóng góp gì, kể cả khi owner tự mở rộng
// portfolio bằng năng lực riêng. Công thức: equity_moi = equity_cu * (giaTriTruoc / giaTriSau).
function diluteShareholders(state: any, ownerId: number, valueBefore: number, valueAdded: number) {
  if (valueAdded <= 0) return;
  const valueAfter = valueBefore + valueAdded;
  if (valueAfter <= 0) return;
  const ratio = valueBefore / valueAfter; // < 1, càng mua thêm nhiều đất mới thì càng loãng
  state.players.forEach((sp: any) => {
    if (sp.status === "shareholder" && sp.shareholderOf === ownerId && sp.shareholderEquity > 0) {
      const oldEq = sp.shareholderEquity;
      sp.shareholderEquity = oldEq * ratio;
      state.log.unshift(`📉 Cổ phần của ${sp.name} tại ${state.players[ownerId].name} bị pha loãng từ ${Math.round(oldEq*100)}% xuống ${Math.round(sp.shareholderEquity*100)}% (do ${state.players[ownerId].name} tự mua thêm đất mới).`);
    }
  });
}

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

  // An toàn: nếu vì lý do bất kỳ không còn ai đang "active" (ví dụ MC loại hết các đội còn lại),
  // dừng game hẳn thay vì lặp vô ích tìm mãi không ra người active — tránh mọi khả năng bị treo.
  const anyActive = state.turnOrder.some((id: number) => state.players[id].status === "active");
  if (!anyActive) {
    state.gameEnded = true;
    return;
  }

  let pos = state.currentTurnPos;
  let tries = 0;
  do {
    pos = (pos + 1) % n;
    tries++;
  } while (state.players[state.turnOrder[pos]].status !== "active" && tries <= n);
  state.currentTurnPos = pos;

  // QUAN TRỌNG: mỗi lần chuyển lượt PHẢI reset lại 2 mốc đếm ngược, nếu không:
  // - turnStartedAt cũ (của lượt trước) khiến đồng hồ 10s của người tiếp theo bị sai/hết ngay lập tức
  // - pendingBuyExpireAt cũ có thể còn sót lại từ lượt trước gây hiển thị sai
  state.turnStartedAt = Date.now();
  state.pendingBuyExpireAt = null;
}

// ── Di chuyển player theo `sum` ô + xử lý ô đáp xuống (thuế/nhà nước/tù/đất) ──
// Dùng chung cho cả roll bình thường VÀ roll-đôi-trong-tù (vì luật thật: đổ đôi trong tù
// thì được ra tù NGAY và đi tiếp đúng số điểm vừa đổ, đáp ô nào xử lý ô đó bình thường).
// `events` là mảng các dòng text để hiện banner giữa bàn cho TẤT CẢ người xem.
// Tự động loại 1 người chơi nếu tiền của họ âm sau khi bị trừ (thuế / phí nhà nước / tiền thuê).
// Giải phóng hết đất họ đang sở hữu (trả về trạng thái "trống") và ghi log + banner cho mọi người.
// Chỉ tác động lên người đang "active" — không đụng tới người đã là cổ đông (shareholder) hay đã
// bị loại từ trước, tránh loại nhầm/loại lại.
function autoEliminateIfBankrupt(state: any, player: any, playerId: number, events: string[]) {
  if (player.status !== "active" || player.money >= 0) return;
  player.status = "eliminated";
  state.tiles.forEach((t: any) => { if (t.owner === playerId) t.owner = null; });
  player.properties = [];
  const msg = `${player.name} hết khả năng chi trả (${player.money.toLocaleString()}$) — TỰ ĐỘNG bị loại khỏi cuộc chơi!`;
  state.log.unshift(msg);
  events.push(`💀 ${msg}`);
}

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
    events.push(`💸 "Đóng thuế là nghĩa vụ của mỗi cá nhân." — ${player.name} nộp 100$.`);
    autoEliminateIfBankrupt(state, player, playerId, events);
    advanceTurn(state);
  } else if (tile.type === "state") {
    player.money -= 100;
    const msg = `${player.name} dừng tại ô ${tile.name} — nộp phí dịch vụ nhà nước 100$`;
    state.log.unshift(msg);
    events.push(`🏛️ Doanh nghiệp không được phép mua ô này — ${player.name} phải trả phí 100$ cho Nhà nước.`);
    autoEliminateIfBankrupt(state, player, playerId, events);
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
      // Cố tình KHÔNG set pendingBuyExpireAt ở đây: đồng hồ đếm ngược 15s mua đất chỉ được phép
      // bắt đầu chạy SAU KHI animation di chuyển quân cờ tới ô đích đã chạy xong ở phía client
      // (xem hàm startBuyTimerIfNeeded() trong index.html, gọi mutateState() ngay trước khi mở
      // modal Mua đất — đúng lúc token vừa "chạm" tới ô đích trên màn hình).
      state.pendingBuyExpireAt = null;
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
      autoEliminateIfBankrupt(state, player, playerId, events);
      advanceTurn(state);
    }
  } else {
    advanceTurn(state);
  }
}

// ── Toàn bộ logic validate + áp dụng 1 action lên state ──
// Ném AppError nếu action không hợp lệ. Trả về { dice, events }.
function applyAction(state: any, playerId: number, action: string, reason?: string, expectedIdx?: number): { dice: [number, number] | null; events: string[] } {
  // Game đang bị MC tạm dừng → chặn TOÀN BỘ hành động (roll/jail/mua đất/skip...), bất kể đang ở
  // bước nào của lượt chơi. Đảm bảo Pause có tác dụng THẬT, không chỉ là ẩn nút ở giao diện.
  if (state.paused) {
    throw new AppError("Game đang tạm dừng — chờ MC tiếp tục.", 403);
  }

  // "start-buy-timer": hành động ĐẶC BIỆT, không gắn với quyết định của 1 người chơi cụ thể — chỉ
  // để khởi động mốc pendingBuyExpireAt bằng ĐỒNG HỒ SERVER, ngay SAU KHI animation di chuyển quân
  // cờ đã chạy xong ở phía client gọi nó (xem startBuyTimerIfNeeded()/selfHealTimers() trong
  // index.html). Bất kỳ client nào cũng được phép gọi (kể cả màn hình trình chiếu không có
  // playerId thật) — vì vậy xử lý TRƯỚC bước kiểm tra "đúng lượt của playerId" bên dưới, và
  // KHÔNG được đụng vào `state.players[playerId]` (có thể không tồn tại/không hợp lệ).
  // Idempotent + an toàn tuyệt đối với luồng chơi game thật:
  //   - Nếu đã hết hạn mua đất (đã mua/bỏ qua) thì không có gì để làm → trả về êm, không báo lỗi.
  //   - Nếu ô đang chờ mua đã đổi khác `expectedIdx` (state đổi từ lúc client gọi tới giờ) → bỏ
  //     qua an toàn, không set nhầm giờ cho ô mua đất khác.
  //   - Nếu đã có pendingBuyExpireAt rồi (client khác gọi trước) → KHÔNG ghi đè, giữ nguyên mốc cũ.
  if (action === "start-buy-timer") {
    const idx = state.pendingBuyTile;
    if (idx === null || idx === undefined) {
      return { dice: null, events: [] };
    }
    if (typeof expectedIdx === "number" && expectedIdx !== idx) {
      return { dice: null, events: [] };
    }
    if (!state.pendingBuyExpireAt) {
      state.pendingBuyExpireAt = Date.now() + BUY_TIMEOUT_MS;
    }
    return { dice: null, events: [] };
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

    // Giống buy-no/skip-turn: chỉ thẩm định giờ khi là lần gọi TỰ ĐỘNG (reason có giá trị) — nút
    // bấm tay "Chờ thêm lượt" của người chơi (reason rỗng) là lựa chọn TỰ NGUYỆN, không tốn tiền,
    // không có gì để gian lận nên không cần chờ hết giờ mới cho bấm.
    if (reason === "disconnect" || reason === "afk") {
      const requiredMs = reason === "disconnect" ? DISCONNECT_SKIP_TIMEOUT_MS : AFK_TIMEOUT_MS;
      if (state.turnStartedAt && Date.now() - state.turnStartedAt < requiredMs - TIMEOUT_GRACE_MS) {
        throw new AppError("Chưa hết thời gian roll", 400);
      }
    }

    player.jailTurns -= 1;
    if (reason === "disconnect") {
      const msg = `${player.name} bị MẤT KẾT NỐI — tự động chờ thêm 1 lượt trong tù.`;
      state.log.unshift(msg);
      events.push(`🔌 ${msg}`);
    } else {
      state.log.unshift(`${player.name} chờ thêm 1 lượt trong tù.`);
    }
    advanceTurn(state);
  } else if (action === "buy-yes") {
    const idx = state.pendingBuyTile;
    if (idx === null || idx === undefined) throw new AppError("Không có đất nào đang chờ mua", 400);

    const tile = state.tiles[idx];
    if (tile.owner !== null) throw new AppError("Đất đã có chủ", 400);

    const price = TILE_PRICES[idx] || 0;
    if (player.money < price) throw new AppError("Không đủ tiền mua đất", 400);

    // Giá trị portfolio đất của player TRƯỚC KHI thêm ô mới — dùng để pha loãng % cổ đông (nếu
    // có) ngay bên dưới, PHẢI tính trước dòng player.properties.push(idx).
    const valueBefore = player.properties.reduce((sum: number, i: number) => sum + (TILE_PRICES[i] || 0), 0);

    player.money -= price;
    tile.owner = playerId;
    player.properties.push(idx);
    diluteShareholders(state, playerId, valueBefore, price);
    const msg = `${player.name} đã mua ${tile.name} giá ${price.toLocaleString()}$.`;
    state.log.unshift(msg);
    events.push(`🏠 ${msg}`);
    state.pendingBuyTile = null;
    advanceTurn(state);
  } else if (action === "buy-no") {
    const idx = state.pendingBuyTile;
    if (idx === null || idx === undefined) throw new AppError("Không có đất nào đang chờ mua", 400);

    // Chỉ áp dụng thẩm định giờ khi đây là lần gọi TỰ ĐỘNG (client watchdog nhắc do hết 15s) —
    // KHÔNG áp dụng khi người chơi tự bấm tay nút "Không mua" (reason rỗng, muốn bỏ qua lúc nào
    // cũng được, không cần chờ hết giờ). Với lần gọi tự động: server tự đối chiếu lại bằng ĐÚNG
    // đồng hồ của chính nó (Date.now(), không tin số giờ ước lượng phía client) — nhờ vậy dù 1
    // client nào đó lỡ tính lệch (hiếm, do sai số đo nowSynced() còn sót lại) và nhắc SỚM hơn
    // thật, server vẫn từ chối, không cho phép cắt ngắn thời gian quyết định của người chơi.
    if (reason === "timeout") {
      if (!state.pendingBuyExpireAt || Date.now() < state.pendingBuyExpireAt - TIMEOUT_GRACE_MS) {
        throw new AppError("Chưa hết thời gian mua đất", 400);
      }
    }

    // LUẬT MỚI: dù không mua, vẫn phải trả phí mặt bằng (= đúng số tiền phí thuê của ô đó) cho
    // Nhà nước — không còn "bỏ qua miễn phí" như trước nữa. Tiền này không thuộc về ai (chưa có
    // chủ đất), giống hệt cách ô thuế/ô nhà nước trừ tiền mà không cộng cho ai.
    const tile = state.tiles[idx];
    const fee = tile.rent || 0;
    player.money -= fee;
    const msg = `${player.name} không mua ${tile.name} — vẫn phải trả phí mặt bằng ${fee.toLocaleString()}$ cho Nhà nước.`;
    state.log.unshift(msg);
    events.push(`🏢 ${msg}`);
    autoEliminateIfBankrupt(state, player, playerId, events);
    state.pendingBuyTile = null;
    advanceTurn(state);
  } else if (action === "skip-turn") {
    // Client tự gọi action này khi hết giờ mà người chơi chưa roll — có 2 lý do:
    // "afk" (đủ 45s AFK_TIMEOUT, vẫn còn kết nối) hoặc "disconnect" (mất kết nối thật, chỉ 8s).
    if (player.jailTurns > 0) {
      throw new AppError("Bạn đang ở trong tù, không áp dụng skip-turn ở đây", 400);
    }
    if (state.pendingBuyTile !== null) {
      throw new AppError("Còn đang chờ quyết định mua đất, chưa thể bỏ lượt roll", 400);
    }
    // ĐÃ SIẾT LẠI: trước đây chỉ chặn dưới 1 mốc chung 7.5s cho MỌI reason — nghĩa là 1 client lỗi/
    // gian lận có thể gọi reason:"afk" (đáng lẽ phải đợi đủ 45s) nhưng chỉ cần đợi 7.5s là qua được
    // kiểm tra. Giờ đối chiếu ĐÚNG ngưỡng tương ứng với từng reason, bằng chính đồng hồ server —
    // không còn tin số liệu ước lượng thời gian phía client nữa.
    const requiredMs = reason === "disconnect" ? DISCONNECT_SKIP_TIMEOUT_MS : AFK_TIMEOUT_MS;
    if (state.turnStartedAt && Date.now() - state.turnStartedAt < requiredMs - TIMEOUT_GRACE_MS) {
      throw new AppError("Chưa hết thời gian roll", 400);
    }
    if (reason === "disconnect") {
      const msg = `${player.name} bị MẤT KẾT NỐI — tự động bỏ lượt (quá lượt).`;
      state.log.unshift(msg);
      events.push(`🔌 ${msg}`);
    } else {
      const msg = `${player.name} hết giờ, bị bỏ lượt.`;
      state.log.unshift(msg);
      events.push(`⏭️ ${msg}`);
    }
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
    const { roomId, playerId, action = "roll", reason, expectedIdx } = await req.json();

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
        result = applyAction(state, playerId, action, reason, expectedIdx);
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
          // serverTime: Date.now() lấy NGAY LÚC trả response — dùng ở supabase-client.js phía
          // client (gameAction()) làm mẫu đo lệch đồng hồ chính xác tới mili-giây, thay cho việc
          // chỉ dựa vào header HTTP "Date" (vốn chỉ chính xác tới giây, gây nhảy số khi hiển thị
          // đếm ngược mua đất). Không ảnh hưởng gì tới validate/luật chơi — chỉ là thông tin thêm.
          JSON.stringify({ ok: true, dice: result.dice, events: result.events, state, serverTime: Date.now() }),
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
