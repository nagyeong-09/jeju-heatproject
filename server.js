require("dotenv").config();

const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const KMA_API_KEY = process.env.KMA_API_KEY;

if (!KMA_API_KEY) {
  console.error("❌ KMA_API_KEY가 .env에 없습니다.");
  process.exit(1);
}

// --------------------------------------------------
// 기본 설정
// --------------------------------------------------

app.use(express.json());

// index.html 등 현재 프로젝트 파일 제공
app.use(express.static(__dirname));

const KMA_BASE_URL =
  "https://apihub.kma.go.kr/api/typ01/url/kma_sfctm2.php";

// 제주 4개 대표 ASOS
const STATIONS = {
  north: {
    regionKey: "north",
    region: "제주시",
    stationName: "제주",
    stationId: 184,
  },

  south: {
    regionKey: "south",
    region: "서귀포",
    stationName: "서귀포",
    stationId: 189,
  },

  east: {
    regionKey: "east",
    region: "성산",
    stationName: "성산",
    stationId: 188,
  },

  west: {
    regionKey: "west",
    region: "고산",
    stationName: "고산",
    stationId: 185,
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

// KMA 결측값
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

  console.log("KMA 요청:", tm);

  const response = await fetch(url);

  const buffer = await response.arrayBuffer();

  // KMA 응답은 EUC-KR
  const text = new TextDecoder("euc-kr").decode(buffer);

  if (!response.ok) {
    throw new Error(`KMA HTTP ${response.status}`);
  }

  // 인증 오류 확인
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

    // 설명/헤더/주석
    if (
      line.startsWith("#") ||
      line.startsWith("!") ||
      line.startsWith("<")
    ) {
      continue;
    }

    const parts = line.split(/\s+/);

    /*
      KMA ASOS 시간자료

      0  TM
      1  STN
      2  WD
      3  WS
      4  GST_WD
      5  GST_WS
      6  GST_TM
      7  PA
      8  PS
      9  PT
      10 PR
      11 TA
      12 TD
      13 HM
      14 PV
      15 RN
      16 RN_DAY
      17 RN_JUN
      18 RN_INT
      19 SD_HR3
      20 SD_DAY
      21 SD_TOT
      22 WC
      23 WP
      24 WW
      25 CA_TOT
      26 CA_MID
      27 CH_MIN
      28 CT
      29 CT_TOP
      30 CT_MID
      31 CT_LOW
      32 VS
      33 SS
      34 SI
    */

    if (parts.length < 35) {
      continue;
    }

    const time = parts[0];
    const stationId = Number(parts[1]);

    if (!Number.isFinite(stationId)) {
      continue;
    }

    const station = Object.values(STATIONS).find(
      (s) => s.stationId === stationId
    );

    if (!station) {
      continue;
    }

    const wind = toNumber(parts[3]);
    const temp = toNumber(parts[11]);
    const humidity = toNumber(parts[13]);
    const solar = toNumber(parts[34]);

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

  console.log("📡 KMA 파싱 결과:", rows.length);

  if (rows.length > 0) {
    console.log("📊 첫 번째 관측값:", rows[0]);
  }

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

  // Stull 식 적용 범위
  if (rh < 5 || rh > 99 || temp < -20 || temp > 50) {
    return null;
  }

  const tw =
    temp *
      Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(temp + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 *
      Math.pow(rh, 1.5) *
      Math.atan(0.023101 * rh) -
    4.686035;

  return tw;
}

// --------------------------------------------------
// KMA2006 WBGT
// --------------------------------------------------

function calculateWBGT(temp, rh, wind, solar) {
  /*
    KMA2006

    Tg =
      0.926 Ta
      - 0.028 RH
      - 0.783 WS
      + 10.441 sqrt(Slr)
      + 2.784

    WBGT =
      0.7 Tw
      + 0.2 Tg
      + 0.1 Ta
  */

  if (
    temp === null ||
    rh === null ||
    wind === null ||
    solar === null
  ) {
    return null;
  }

  if (
    !Number.isFinite(temp) ||
    !Number.isFinite(rh) ||
    !Number.isFinite(wind) ||
    !Number.isFinite(solar)
  ) {
    return null;
  }

  // 음수 일사량은 결측으로 처리
  if (solar < 0) {
    return null;
  }

  const tw = calculateWetBulb(temp, rh);

  if (tw === null) {
    return null;
  }

  const tg =
    0.926 * temp -
    0.028 * rh -
    0.783 * wind +
    10.441 * Math.sqrt(solar) +
    2.784;

  const wbgt =
    0.7 * tw +
    0.2 * tg +
    0.1 * temp;

  return Number(wbgt.toFixed(1));
}

// --------------------------------------------------
// 위험 단계
// --------------------------------------------------

function getRisk(wbgt) {
  if (wbgt === null || !Number.isFinite(wbgt)) {
    return {
      level: "자료 부족",
      code: "unknown",
    };
  }

  if (wbgt >= 35) {
    return {
      level: "매우 위험",
      code: "very-danger",
    };
  }

  if (wbgt >= 33) {
    return {
      level: "위험",
      code: "danger",
    };
  }

  if (wbgt >= 31) {
    return {
      level: "주의",
      code: "caution",
    };
  }

  if (wbgt >= 28) {
    return {
      level: "관찰",
      code: "watch",
    };
  }

  return {
    level: "거의 안전",
    code: "safe",
  };
}

// --------------------------------------------------
// 관측값 → 서비스 데이터
// --------------------------------------------------

function makeWeatherItem(row) {
  const wbgt = calculateWBGT(
    row.temp,
    row.humidity,
    row.wind,
    row.solar
  );

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

// --------------------------------------------------
// 특정 시각의 최신 데이터 가져오기
// --------------------------------------------------

async function fetchAtTime(date) {
  const tm = formatKmaTime(date);

  try {
    const text = await fetchKma(tm);
    const rows = parseKmaRows(text);

    return rows.map(makeWeatherItem);
  } catch (error) {
    console.error(
      `KMA ${tm} 요청 실패:`,
      error.message
    );

    return [];
  }
}

// --------------------------------------------------
// 현재 자료
// --------------------------------------------------

async function fetchLatest() {
  const now = new Date();

  // KMA 자료가 정시 단위로 들어오는 것을 고려해
  // 최근 6시간을 역순으로 확인
  for (let i = 0; i <= 6; i++) {
    const target = new Date(now);

    target.setMinutes(0, 0, 0);
    target.setHours(target.getHours() - i);

    const rows = await fetchAtTime(target);

    if (rows.length > 0) {
      console.log(
        `✅ 최신 관측자료 확보: ${formatDisplayTime(target)}`
      );

      return rows;
    }
  }

  console.warn("⚠️ 최근 6시간 내 관측자료가 없습니다.");

  return [];
}

// --------------------------------------------------
// 최근 24시간 데이터
// --------------------------------------------------

let historyCache = {
  timestamp: 0,
  data: null,
};

// 5분 동안 캐시
const HISTORY_CACHE_MS = 5 * 60 * 1000;

async function fetchHistory() {
  const nowMs = Date.now();

  if (
    historyCache.data &&
    nowMs - historyCache.timestamp < HISTORY_CACHE_MS
  ) {
    console.log("📦 24시간 데이터 캐시 사용");

    return historyCache.data;
  }

  const history = {
    north: [],
    south: [],
    east: [],
    west: [],
  };

  const now = new Date();

  now.setMinutes(0, 0, 0);

  /*
    sfctm3 기간조회 API 대신
    sfctm2 시간조회 API를 사용한다.

    이유:
    - 현재 API 키가 시간조회에서 정상 작동
    - 기간조회 API는 별도 이용승인 문제로 403이 발생할 수 있음
    - 발표 직전에는 안정적인 방식이 우선
  */

  for (let i = 23; i >= 0; i--) {
    const target = new Date(now);
    target.setHours(target.getHours() - i);

    const rows = await fetchAtTime(target);

    for (const item of rows) {
      if (!history[item.regionKey]) {
        history[item.regionKey] = [];
      }

      history[item.regionKey].push(item);
    }
  }

  // 시간순 정렬
  for (const key of Object.keys(history)) {
    history[key].sort((a, b) => {
      return (
        String(a.observedAt).localeCompare(
          String(b.observedAt)
        )
      );
    });
  }

  historyCache = {
    timestamp: Date.now(),
    data: history,
  };

  console.log("✅ 최근 24시간 데이터 생성 완료");

  return history;
}

// --------------------------------------------------
// 메인 API
// --------------------------------------------------

app.get("/api/weather", async (req, res) => {
  try {
    console.log("");
    console.log("========================================");
    console.log("🌤 제주 온열환경 데이터 요청");
    console.log("========================================");

    const requestedAt = new Date();

    /*
      현재 데이터와 24시간 데이터 중
      하나가 실패하더라도 전체 API가 죽지 않도록
      각각 안전하게 처리
    */

    const current = await fetchLatest();

    let history = {};

    try {
      history = await fetchHistory();
    } catch (error) {
      console.error(
        "⚠️ 24시간 데이터 생성 실패:",
        error.message
      );

      history = {
        north: [],
        south: [],
        east: [],
        west: [],
      };
    }

    console.log(
      `현재 지역 수: ${current.length}`
    );

    console.log(
      `24시간 데이터:`,
      Object.fromEntries(
        Object.entries(history).map(
          ([key, value]) => [key, value.length]
        )
      )
    );

    res.json({
      success: true,

      requestedAt: formatDisplayTime(requestedAt),

      updatedAt:
        current.length > 0
          ? current[0].observedAt
          : formatKmaTime(requestedAt),

      requestedTime: formatDisplayTime(requestedAt),

      source: "기상청 ASOS",
      model: "KMA2006",

      data: current,
      regions: current,

      history,
    });
  } catch (error) {
    console.error("❌ /api/weather 오류:", error);

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// --------------------------------------------------
// 현재 데이터만
// --------------------------------------------------

app.get("/api/weather/current", async (req, res) => {
  try {
    const current = await fetchLatest();

    res.json({
      success: true,
      updatedAt:
        current.length > 0
          ? current[0].observedAt
          : null,
      source: "기상청 ASOS",
      model: "KMA2006",
      data: current,
    });
  } catch (error) {
    console.error(
      "/api/weather/current 오류:",
      error
    );

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// --------------------------------------------------
// 24시간 데이터만
// --------------------------------------------------

app.get("/api/weather/history", async (req, res) => {
  try {
    const history = await fetchHistory();

    res.json({
      success: true,
      updatedAt: formatDisplayTime(new Date()),
      source: "기상청 ASOS",
      model: "KMA2006",
      history,
    });
  } catch (error) {
    console.error(
      "/api/weather/history 오류:",
      error
    );

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// --------------------------------------------------
// 서버 상태
// --------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    server: "JEJU HEAT GUARD",
    status: "running",
    time: new Date().toISOString(),
  });
});

// --------------------------------------------------
// 루트
// --------------------------------------------------

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

// --------------------------------------------------
// 서버 실행
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("========================================");
  console.log("🔥 JEJU HEAT GUARD SERVER");
  console.log("========================================");
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`🌐 API: http://localhost:${PORT}/api/weather`);
  console.log(`🌐 Health: http://localhost:${PORT}/api/health`);
  console.log("📡 기상청 ASOS");
  console.log("📐 WBGT 모델: KMA2006");
  console.log(
    "📍 제주(184) / 고산(185) / 성산(188) / 서귀포(189)"
  );
  console.log("========================================");
  console.log("");
});