/* ============================================================
   game-data.js — dữ liệu & luật chơi dùng chung
   ============================================================ */

const NUM_PLAYERS = 8;
const START_MONEY = 1500;
const PASS_START_BONUS = 200;
const TAX_AMOUNT = 100;
const STATE_FEE = 100;
const WEAK_THRESHOLD = 300;
const MONOPOLY_TILE_PCT = 0.4;
const ANTITRUST_TAX = 300;
const PRIORITY_FEE = 50;
const PHASE_NAMES = [
  "1 - Cạnh tranh tự do",
  "2 - Hình thành độc quyền",
  "3 - Doanh nghiệp độc quyền",
  "4 - Nhà nước can thiệp"
];
const PHASE_SUGGEST_SECONDS = [10*60, 20*60, 25*60, 28*60];

const RAW_TILES = [
  ["Chăn nuôi gà","property","NN",250,90],
  ["Cty điện tử","property","TN",350,120],
  ["Trang trại lúa","property","NN",120,40],
  ["Trường học","property","DV",250,90],
  ["Chuỗi bán lẻ","property","TN",180,60],
  ["Nước","state",null,0,0],
  ["Trồng cao su","property","NN",350,120],
  ["Ngân hàng","property","DV",180,60],
  ["Logistic","property","TN",250,90],
  ["Cty tư vấn","property","DV",350,120],
  ["Vào Tù","jail",null,0,0],
  ["Trồng Chè","property","NN",350,120],
  ["Siêu thị","property","TN",180,60],
  ["Bệnh viện","property","DV",250,90],
  ["Trồng hoa","property","NN",250,90],
  ["Cty ô tô","property","TN",350,120],
  ["Thuế","tax",null,0,0],
  ["Chăn nuôi heo","property","NN",180,60],
  ["Cty bảo hiểm","property","DV",400,180],
  ["Trang trại rau","property","NN",120,40],
  ["Xuất phát","start",null,0,0],
  ["Cty truyền thông","property","TN",350,120],
  ["Nhà máy may","property","TN",250,90],
  ["Khách sạn","property","DV",120,40],
  ["Cty thực phẩm","property","TN",250,90],
  ["Trồng điều","property","NN",400,180],
  ["Bán tạp hóa","property","TN",120,40],
  ["Nhà hàng","property","DV",180,60],
  ["Trồng cà phê","property","NN",350,120],
  ["Cty du lịch","property","DV",250,90],
  ["Vào Tù","jail",null,0,0],
  ["Cty viễn thông","property","TN",400,180],
  ["Vườn trái cây","property","NN",180,60],
  ["Cty dược phẩm","property","TN",400,180],
  ["Chăn nuôi bò","property","NN",180,60],
  ["Hàng không","property","DV",250,90],
  ["Điện Lực","state",null,0,0],
  ["Nuôi tôm","property","NN",250,90],
  ["Vật liệu xây dựng","property","TN",250,90],
  ["Cty công nghệ","property","TN",350,120],
];
const TOTAL_TILES = RAW_TILES.length;
const START_TILE_INDEX = RAW_TILES.findIndex(t=>t[1]==="start");

const LAND_COLOR = {NN:"#4ade80", TN:"#fb923c", DV:"#c084fc"};
const PLAYER_COLORS = ["#ef4444","#3b82f6","#22c55e","#eab308","#a855f7","#06b6d4","#f97316","#ec4899"];

const TYPE_TOTALS = {NN:0, TN:0, DV:0};
RAW_TILES.forEach(([,type,landType])=>{ if(type==="property") TYPE_TOTALS[landType]++; });

function tileInfo(idx){
  const [name,type,landType,price,rent] = RAW_TILES[idx];
  return {idx,name,type,landType,price,rent};
}

function createInitialState(){
  const players = [];
  for(let i=0;i<NUM_PLAYERS;i++){
    players.push({
      id:i, name:"(Trống)", color:PLAYER_COLORS[i],
      joined:false, claimToken:null,
      money:START_MONEY, position:START_TILE_INDEX, properties:[],
      status:"active", shareholderOf:null, shareholderEquity:0, jailTurns:0
    });
  }
  const tiles = RAW_TILES.map(()=>({owner:null, rentMultiplier:1}));
  return {
    initialized:true, phase:0, elapsedSec:0, gameStarted:false,
    turnOrder:[], turnOrderLocked:false, priorityUsed:false,
    currentTurnPos:0, players, tiles, lastDice:null,
    log:["Đang chờ người chơi vào phòng và nhập tên đội..."], gameEnded:false
  };
}

function totalAssets(state, p){
  const propVal = p.properties.reduce((sum,i)=>sum+RAW_TILES[i][3],0);
  return p.money + propVal;
}
function isWeak(state, p){ return p.status==="active" && totalAssets(state,p) <= WEAK_THRESHOLD; }
function isMonopoly(state, p){
  if(p.status!=="active") return false;
  if(p.properties.length >= Math.ceil(TOTAL_TILES*MONOPOLY_TILE_PCT)) return true;
  const counts = {NN:0,TN:0,DV:0};
  p.properties.forEach(i=>{ const t=tileInfo(i); if(t.type==="property") counts[t.landType]++; });
  return counts.NN===TYPE_TOTALS.NN || counts.TN===TYPE_TOTALS.TN || counts.DV===TYPE_TOTALS.DV;
}
function currentPlayerId(state){
  if(!state.turnOrderLocked) return null;
  return state.turnOrder[state.currentTurnPos];
}
function addLog(state, msg){
  state.log = [msg, ...state.log].slice(0,60);
}
function joinedPlayers(state){ return state.players.filter(p=>p.joined); }

// Hàm hỗ trợ cổ đông
function makeShareholderOf(s, shareholderId, ownerId){
  const sp = s.players[shareholderId];
  const op = s.players[ownerId];
  const transferVal = sp.properties.reduce((sum,idx)=> sum + RAW_TILES[idx][3], 0);
  const ownerCurVal = op.properties.reduce((sum,idx)=> sum + RAW_TILES[idx][3], 0);
  const totalAfter = ownerCurVal + transferVal;
  const equity = totalAfter === 0 ? 1 : (transferVal / totalAfter);

  sp.properties.forEach(idx=>{ s.tiles[idx].owner = ownerId; op.properties.push(idx); });
  sp.properties = [];
  sp.status = "shareholder";
  sp.shareholderOf = ownerId;
  sp.shareholderEquity = equity;
  addLog(s, `🤝 ${sp.name} trở thành cổ đông của ${op.name} — cổ phần ${Math.round(equity*100)}%`);
}
