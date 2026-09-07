require("dotenv").config();

const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// API KEY 개별 할당
const KMA_API_KEY = process.env.KMA_API_KEY;
const SHELTER_API_KEY = process.env.SHELTER_API_KEY;
const HOSPITAL_API_KEY = process.env.HOSPITAL_API_KEY;
const HEALTH_CENTER_API_KEY = process.env.HEALTH_CENTER_API_KEY;
const TRAFFIC_API_KEY= process.env.TRAFFIC_API_KEY;

if (!KMA_API_KEY) {
  console.error("❌ KMA_API_KEY가 환경변수에 없습니다.");
}

// --------------------------------------------------
// 기본 설정
// --------------------------------------------------

app.use(express.json());
app.use(express.static(__dirname));

const KMA_BASE_URL = "https://apihub.kma.go.kr/api/typ01/url/kma_sfctm2.php";

// 제주 4개 관측지점 (AWS 데이터 연동 유지)
const STATIONS = {
  north: {
    regionKey: "north",
    region: "제주시",
    stationName: "제주",
    stationId: 184,
  },
  west: {
    regionKey: "west",
    region: "고산",
    stationName: "고산",
    stationId: 185,
  },
  east: {
    regionKey: "east",
    region: "성산",
    stationName: "성산",
    stationId: 188,
  },
  south: {
    regionKey: "south",
    region: "서귀포",
    stationName: "서귀포",
    stationId: 189,
  },
};

const STATION_IDS = Object.values(STATIONS).map((s) => s.stationId);

// --------------------------------------------------
// 유틸
// --------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatKmaTime(date) {
  return (
    date.getFullYear() +
    pad2(date.getMonth() + 1) +
    pad2(date.getDate()) +
    pad2(date.getHours()) +
    pad2(date.getMinutes())
  );
}

function formatDisplayTime(date) {
  return (
    date.getFullYear() +
    "." +
    pad2(date.getMonth() + 1) +
    "." +
    pad2(date.getDate()) +
    " " +
    pad2(date.getHours()) +
    ":" +
    pad2(date.getMinutes())
  );
}

function toNumber(value) {
  if (value === undefined || value === null) return null;
  const n = Number(String(value).trim());
  if (!Number.isFinite(n)) return null;
  // KMA 결측값
  if (n === -9 || n === -99 || n === -999 || n === -999.0) {
    return null;
  }
  return n;
}

// --------------------------------------------------
// KMA API 호출
// --------------------------------------------------

async function fetchKma(tm) {
  const stationString = STATION_IDS.join(":");
  const url =
    `${KMA_BASE_URL}` +
    `?tm=${tm}` +
    `&stn=${stationString}` +
    `&help=1` +
    `&authKey=${encodeURIComponent(KMA_API_KEY)}`;

  console.log("KMA AWS 요청:", tm);

  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  const text = new TextDecoder("euc-kr").decode(buffer);

  if (!response.ok) {
    throw new Error(`KMA HTTP ${response.status}`);
  }

  if (
    text.includes("인증키") &&
    (text.includes("오류") ||
      text.includes("에러") ||
      text.includes("실패") ||
      text.includes("유효하지"))
  ) {
    throw new Error("기상청 API 인증 오류");
  }

  return text;
}

// --------------------------------------------------
// KMA 응답 파싱
// --------------------------------------------------

function parseKmaRows(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#") || line.startsWith("!") || line.startsWith("<")) {
      continue;
    }

    const parts = line.split(/\s+/);
    if (parts.length < 35) continue;

    const time = parts[0];
    const stationId = Number(parts[1]);
    if (!Number.isFinite(stationId)) continue;

    const station = Object.values(STATIONS).find(
      (s) => s.stationId === stationId
    );
    if (!station) continue;

    const wind = toNumber(parts[3]);  // WS = 풍속 (parts[3])
    const temp = toNumber(parts[11]); // TA = 기온 (parts[11])
    const humidity = toNumber(parts[13]); // HM = 상대습도 (parts[13])
    const solar = toNumber(parts[34]);   // SI = 일사량 (parts[34])

    // 성산 station 188의 SI 값 디버깅 로그 (필수 로그 조건)
    if (stationId === 188) {
      console.log(`[디버그] 성산(188) SI: ${solar}, TA: ${temp}, HM: ${humidity}, WS: ${wind}`);
    }

    rows.push({
      time,
      stationId,
      regionKey: station.regionKey,
      region: station.region,
      stationName: station.stationName,
      wind,
      temp,
      humidity,
      solar,
    });
  }

  console.log("📡 KMA AWS 파싱 결과 개수:", rows.length);
  return rows;
}

// --------------------------------------------------
// Stull(2011) 습구온도
// --------------------------------------------------

function calculateWetBulb(temp, rh) {
  if (
    temp === null ||
    rh === null ||
    !Number.isFinite(temp) ||
    !Number.isFinite(rh)
  ) {
    return null;
  }

  if (rh < 5 || rh > 99 || temp < -20 || temp > 50) {
    return null;
  }

  const tw =
    temp * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(temp + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
    4.686035;

  return tw;
}

// --------------------------------------------------
// KMA2006 WBGT 공식
// --------------------------------------------------

function calculateWBGT(temp, rh, wind, solar) {
  // SI 결측 시 null 처리 (0으로 강제 대체 금지)
  if (
    temp === null ||
    rh === null ||
    wind === null ||
    solar === null ||
    !Number.isFinite(temp) ||
    !Number.isFinite(rh) ||
    !Number.isFinite(wind) ||
    !Number.isFinite(solar)
  ) {
    return null;
  }

  if (solar < 0) {
    return null;
  }

  const tw = calculateWetBulb(temp, rh);
  if (tw === null) return null;

  // Tg = 0.926*Ta - 0.028*RH - 0.783*WS + 10.441*sqrt(SI) + 2.784
  const tg =
    0.926 * temp -
    0.028 * rh -
    0.783 * wind +
    10.441 * Math.sqrt(solar) +
    2.784;

  // WBGT = 0.7*Tw + 0.2*Tg + 0.1*Ta
  const wbgt = 0.7 * tw + 0.2 * tg + 0.1 * temp;

  return Number(wbgt.toFixed(1));
}

function getRisk(wbgt) {
  if (wbgt === null || !Number.isFinite(wbgt)) {
    return { level: "자료 부족", code: "unknown" };
  }
  if (wbgt >= 35) return { level: "매우 위험", code: "very-danger" };
  if (wbgt >= 33) return { level: "위험", code: "danger" };
  if (wbgt >= 31) return { level: "주의", code: "caution" };
  if (wbgt >= 28) return { level: "관찰", code: "watch" };
  return { level: "거의 안전", code: "safe" };
}

function makeWeatherItem(row) {
  const wbgt = calculateWBGT(row.temp, row.humidity, row.wind, row.solar);
  const risk = getRisk(wbgt);

  return {
    regionKey: row.regionKey,
    region: row.region,
    name: row.region,
    stationName: row.stationName,
    stationId: row.stationId,
    observedAt: row.time,
    wbgt,
    temp: row.temp,
    humidity: row.humidity,
    wind: row.wind,
    solar: row.solar,
    risk: risk.level,
    riskLevel: risk.level,
    riskCode: risk.code,
  };
}

async function fetchAtTime(date) {
  const tm = formatKmaTime(date);
  try {
    const text = await fetchKma(tm);
    const rows = parseKmaRows(text);
    return rows.map(makeWeatherItem);
  } catch (error) {
    console.error(`KMA ${tm} 요청 실패:`, error.message);
    return [];
  }
}

async function fetchLatest() {
  const now = new Date();
  for (let i = 0; i <= 6; i++) {
    const target = new Date(now);
    target.setMinutes(0, 0, 0);
    target.setHours(target.getHours() - i);

    const rows = await fetchAtTime(target);
    if (rows.length > 0) {
      console.log(`✅ 최신 관측자료(AWS) 확보: ${formatDisplayTime(target)}`);
      return rows;
    }
  }
  console.warn("⚠️ 최근 6시간 내 관측자료가 없습니다.");
  return [];
}

let historyCache = {
  timestamp: 0,
  data: null,
};
const HISTORY_CACHE_MS = 5 * 60 * 1000;

async function fetchHistory() {
  const nowMs = Date.now();
  if (historyCache.data && nowMs - historyCache.timestamp < HISTORY_CACHE_MS) {
    return historyCache.data;
  }

  const history = { north: [], south: [], east: [], west: [] };
  const now = new Date();
  now.setMinutes(0, 0, 0);

  for (let i = 23; i >= 0; i--) {
    const target = new Date(now);
    target.setHours(target.getHours() - i);
    const rows = await fetchAtTime(target);

    for (const item of rows) {
      if (history[item.regionKey]) {
        history[item.regionKey].push(item);
      }
    }
  }

  for (const key of Object.keys(history)) {
    history[key].sort((a, b) =>
      String(a.observedAt).localeCompare(String(b.observedAt))
    );
  }

  historyCache = { timestamp: Date.now(), data: history };
  return history;
}

// --------------------------------------------------
// 안전데이터 API (쉼터, 병원, 보건소) Pagination & Filtering
// --------------------------------------------------

function parseCoordinate(value) {
  if (value === undefined || value === null) return null;
  const num = Number(String(value).trim());
  return Number.isFinite(num) ? num : null;
}

function extractLatLon(item) {
  const lat =
    parseCoordinate(item.HSPTL_LAT) ||
    parseCoordinate(item.LAT) ||
    parseCoordinate(item.LA) ||
    parseCoordinate(item.LATITUDE) ||
    parseCoordinate(item.Y);

  const lon =
    parseCoordinate(item.HSPTL_LOT) ||
    parseCoordinate(item.HSPTL_LON) ||
    parseCoordinate(item.LOT) ||
    parseCoordinate(item.LO) ||
    parseCoordinate(item.LON) ||
    parseCoordinate(item.LONGITUDE) ||
    parseCoordinate(item.LONG) ||
    parseCoordinate(item.X);

  return { lat, lon };
}

function isJeju(item) {
  const str = JSON.stringify(item);
  return str.includes("제주") || str.includes("제주특별자치도");
}

async function fetchSafetyApiData(endpoint, apiKey) {
  if (!apiKey) {
    console.warn(`⚠️ Key not found for endpoint: ${endpoint}`);
    return [];
  }

  let allRows = [];
  let pageNo = 1;
  const numOfRows = 1000;

  while (pageNo <= 5) {
    const url = `${SAFETY_BASE_URL}${endpoint}?serviceKey=${encodeURIComponent(
      apiKey
    )}&pageNo=${pageNo}&numOfRows=${numOfRows}&type=json`;

    try {
      const response = await fetch(url);
      if (!response.ok) break;
      const json = await response.json();

      let items = [];
      if (json.body && Array.isArray(json.body)) {
        items = json.body;
      } else if (json.response && json.response.body && json.response.body.items) {
        items = Array.isArray(json.response.body.items)
          ? json.response.body.items
          : json.response.body.items.item || [];
      } else if (Array.isArray(json.data)) {
        items = json.data;
      } else if (Array.isArray(json)) {
        items = json;
      }

      if (!items || items.length === 0) break;

      allRows = allRows.concat(items);
      if (items.length < numOfRows) break;
      pageNo++;
    } catch (err) {
      console.error(`안전데이터 API Call Failed (${endpoint}):`, err.message);
      break;
    }
  }

  return allRows.filter(isJeju);
}

// --------------------------------------------------
// ROUTING
// --------------------------------------------------

app.get("/api/weather", async (req, res) => {
  try {
    const requestedAt = new Date();
    const current = await fetchLatest();
    let history = {};

    try {
      history = await fetchHistory();
    } catch (error) {
      history = { north: [], south: [], east: [], west: [] };
    }

    res.json({
      success: true,
      requestedAt: formatDisplayTime(requestedAt),
      updatedAt:
        current.length > 0
          ? current[0].observedAt
          : formatKmaTime(requestedAt),
      source: "AWS 관측자료",
      model: "KMA2006",
      data: current,
      regions: current,
      history,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 안전자원 (쉼터/병원/보건소) API - 각 API 독립 실패 처리
app.get("/api/resources", async (req, res) => {
  console.log("🏥 안전자원 API 요청 수신");

  const results = await Promise.allSettled([
    fetchSafetyApiData("/V2/api/DSSP-IF-10840", HOSPITAL_API_KEY),
    fetchSafetyApiData("/V2/api/DSSP-IF-20535", HEALTH_CENTER_API_KEY),
    fetchSafetyApiData("/V2/api/DSSP-IF-10942", SHELTER_API_KEY),
  ]);

  const hospitalsRaw = results[0].status === "fulfilled" ? results[0].value : [];
  const healthCentersRaw = results[1].status === "fulfilled" ? results[1].value : [];
  const sheltersRaw = results[2].status === "fulfilled" ? results[2].value : [];

  const mapResource = (item, type) => {
    const { lat, lon } = extractLatLon(item);
    return {
      type,
      name: item.DUTYNAME || item.INST_NM || item.RST_NM || item.SHELTER_NM || "명칭 없음",
      address: item.DUTYADDR || item.REFINE_ROADNM_ADDR || item.ADDR || item.SHELTER_ADDR || "",
      phone: item.DUTYTEL1 || item.TEL_NO || "",
      lat,
      lon,
    };
  };

  const hospital = hospitalsRaw.map((item) => mapResource(item, "hospital"));
  const healthCenter = healthCentersRaw.map((item) => mapResource(item, "healthCenter"));
  const shelter = sheltersRaw.map((item) => mapResource(item, "shelter"));

  console.log(`📊 조회 수치 - 병원: ${hospital.length}, 보건소: ${healthCenter.length}, 쉼터: ${shelter.length}`);

  res.json({
    success: true,
    shelterTotalDisplay: 781, // 요구사항: 781개 표기 유지
    hospital,
    healthCenter,
    shelter,
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    server: "JEJU HEAT GUARD",
    status: "running",
    time: new Date().toISOString(),
  });
});

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("========================================");
  console.log("🔥 JEJU HEAT GUARD SERVER (AWS Model: KMA2006)");
  console.log(`🌐 http://localhost:${PORT}`);
  console.log("========================================");
});