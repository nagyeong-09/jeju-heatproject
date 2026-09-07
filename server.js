require("dotenv").config();

const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// API KEY 개별 할당 (기존 환경변수 이름 유지)
const KMA_API_KEY = process.env.KMA_API_KEY;
const SHELTER_API_KEY = process.env.SHELTER_API_KEY;
const HOSPITAL_API_KEY = process.env.HOSPITAL_API_KEY;
const HEALTH_CENTER_API_KEY = process.env.HEALTH_CENTER_API_KEY;
const TRAFFIC_API_KEY = process.env.TRAFFIC_API_KEY;

if (!KMA_API_KEY) {
  console.error("❌ KMA_API_KEY가 환경변수에 없습니다.");
}

// --------------------------------------------------
// 기본 설정
// --------------------------------------------------

app.use(express.json());
app.use(express.static(__dirname));

const KMA_BASE_URL =
  "https://apihub.kma.go.kr/api/typ01/url/kma_sfctm2.php";
const SAFETY_BASE_URL = "https://www.safetydata.go.kr";

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
    (
      text.includes("오류") ||
      text.includes("에러") ||
      text.includes("실패") ||
      text.includes("유효하지")
    )
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

    if (
      line.startsWith("#") ||
      line.startsWith("!") ||
      line.startsWith("<")
    ) {
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

    const wind = toNumber(parts[3]);
    const temp = toNumber(parts[11]);
    const humidity = toNumber(parts[13]);
    const solar = toNumber(parts[34]);

    // 성산 station 188의 SI 값 디버깅 로그 유지
    if (stationId === 188) {
      console.log(
        `[디버그] 성산(188) SI: ${solar}, TA: ${temp}, HM: ${humidity}, WS: ${wind}`
      );
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
    temp * Math.atan(
      0.151977 * Math.sqrt(rh + 8.313659)
    ) +
    Math.atan(temp + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 *
      Math.pow(rh, 1.5) *
      Math.atan(0.023101 * rh) -
    4.686035;

  return tw;
}

// --------------------------------------------------
// KMA2006 WBGT 공식
// --------------------------------------------------

function calculateWBGT(temp, rh, wind, solar) {
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

async function fetchLatest() {
  const now = new Date();

  for (let i = 0; i <= 6; i++) {
    const target = new Date(now);

    target.setMinutes(0, 0, 0);
    target.setHours(
      target.getHours() - i
    );

    const rows = await fetchAtTime(target);

    if (rows.length > 0) {
      console.log(
        `✅ 최신 관측자료(AWS) 확보: ${formatDisplayTime(target)}`
      );

      return rows;
    }
  }

  console.warn(
    "⚠️ 최근 6시간 내 관측자료가 없습니다."
  );

  return [];
}

let historyCache = {
  timestamp: 0,
  data: null,
};

const HISTORY_CACHE_MS = 5 * 60 * 1000;

async function fetchHistory() {
  const nowMs = Date.now();

  if (
    historyCache.data &&
    nowMs - historyCache.timestamp < HISTORY_CACHE_MS
  ) {
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

  for (let i = 23; i >= 0; i--) {
    const target = new Date(now);

    target.setHours(
      target.getHours() - i
    );

    const rows = await fetchAtTime(target);

    for (const item of rows) {
      if (history[item.regionKey]) {
        history[item.regionKey].push(item);
      }
    }
  }

  for (const key of Object.keys(history)) {
    history[key].sort((a, b) =>
      String(a.observedAt).localeCompare(
        String(b.observedAt)
      )
    );
  }

  historyCache = {
    timestamp: Date.now(),
    data: history,
  };

  return history;
}

// --------------------------------------------------
// 안전데이터 API (쉼터, 병원, 보건소)
// --------------------------------------------------

function parseCoordinate(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const num = Number(
    String(value).trim()
  );

  return Number.isFinite(num)
    ? num
    : null;
}

function extractLatLon(item) {
  const latCandidates = [
    item.HSPTL_LAT,
    item.LAT,
    item.LA,
    item.LATITUDE,
    item.WGS84_LAT,
    item.LTTD,
    item.YPOS,
    item.Y,
  ];

  const lonCandidates = [
    item.HSPTL_LOT,
    item.HSPTL_LON,
    item.LOT,
    item.LO,
    item.LON,
    item.LONGITUDE,
    item.WGS84_LON,
    item.WGS84_LOT,
    item.LNGT,
    item.XPOS,
    item.LONG,
    item.X,
  ];

  const lat =
    latCandidates
      .map(parseCoordinate)
      .find((v) => v !== null) ?? null;

  const lon =
    lonCandidates
      .map(parseCoordinate)
      .find((v) => v !== null) ?? null;

  return {
    lat:
      lat !== null &&
      lat >= 33.0 &&
      lat <= 34.0
        ? lat
        : null,

    lon:
      lon !== null &&
      lon >= 125.9 &&
      lon <= 127.1
        ? lon
        : null,
  };
}

function isJejuCoordinate(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= 33.0 &&
    lat <= 34.0 &&
    lon >= 125.9 &&
    lon <= 127.1
  );
}

async function fetchSafetyApiData(
  endpoint,
  apiKey,
  extraParams = {}
) {
  if (!apiKey) {
    throw new Error(
      `API 키가 없습니다: ${endpoint}`
    );
  }

  let allRows = [];
  let pageNo = 1;

  const numOfRows = 1000;
  const maxPages = 100;

  while (pageNo <= maxPages) {
    const params = new URLSearchParams({
      serviceKey: apiKey,
      returnType: "json",
      pageNo: String(pageNo),
      numOfRows: String(numOfRows),
      ...extraParams,
    });

    const url =
      `${SAFETY_BASE_URL}${endpoint}?${params.toString()}`;

    try {
      const response = await fetch(url);
      const rawText = await response.text();

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: ${rawText.slice(
            0,
            300
          )}`
        );
      }

      let json;

      try {
        json = JSON.parse(rawText);
      } catch {
        throw new Error(
          `JSON 파싱 실패: ${rawText.slice(
            0,
            300
          )}`
        );
      }

      const header =
        json?.cmmMsgHeader ||
        json?.response?.header ||
        json?.header;

      const returnAuthMsg =
        header?.returnAuthMsg;

      const resultCode =
        header?.returnReasonCode ||
        header?.resultCode;

      if (
        returnAuthMsg ||
        (
          resultCode &&
          String(resultCode) !== "0"
        )
      ) {
        throw new Error(
          `안전데이터 API 오류 ${
            resultCode || ""
          } ${
            returnAuthMsg || ""
          }`.trim()
        );
      }

      let items = [];

      const candidates = [
        json?.body,
        json?.data,
        json?.items,
        json?.response?.body?.items,
        json?.response?.body,
        json,
      ];

      for (const candidate of candidates) {
        if (Array.isArray(candidate)) {
          items = candidate;
          break;
        }

        if (
          candidate &&
          Array.isArray(candidate.item)
        ) {
          items = candidate.item;
          break;
        }

        if (
          candidate &&
          Array.isArray(candidate.items)
        ) {
          items = candidate.items;
          break;
        }

        if (
          candidate &&
          candidate.items &&
          Array.isArray(candidate.items.item)
        ) {
          items = candidate.items.item;
          break;
        }
      }

      if (!items.length) {
        break;
      }

      allRows.push(...items);

      if (items.length < numOfRows) {
        break;
      }

      pageNo++;
    } catch (err) {
      console.error(
        `❌ 안전데이터 API 실패 [${endpoint}] page=${pageNo}:`,
        err.message
      );

      throw err;
    }
  }

  return allRows;
}

// 행정안전부 병의원 POI
// 종합병원/병의원/요양병원/치과병의원/보건소를 함께 제공합니다.
function mapMedicalResource(item) {
  const { lat, lon } =
    extractLatLon(item);

  const name =
    item.INST_NM ||
    item.DUTYNAME ||
    item.NAME ||
    "명칭 없음";

  const address =
    item.ADDR ||
    item.DUTYADDR ||
    item.ADRES ||
    "";

  const phone =
    item.RPRS_TELNO ||
    item.EMRO_TELNO ||
    item.DUTYTEL1 ||
    item.TEL_NO ||
    item.TEL ||
    "";

  const classification = [
    item.HSPTL_CLSF_NM,
    item.FIAI_MDLCR_INST_CD_NM,
    name,
  ]
    .filter(Boolean)
    .join(" ");

  const isHealthCenter =
    classification.includes("보건소");

  return {
    type: isHealthCenter
      ? "healthCenter"
      : "hospital",
    name,
    address,
    phone,
    lat,
    lon,
  };
}

function mapShelterResource(item) {
  const { lat, lon } =
    extractLatLon(item);

  return {
    type: "shelter",

    name:
      item.REARE_NM ||
      item.SHELTER_NM ||
      item.FCLT_NM ||
      item.NAME ||
      "명칭 없음",

    address:
      item.RONA_DADDR ||
      item.REFINE_ROADNM_ADDR ||
      item.ADDR ||
      item.SHELTER_ADDR ||
      "",

    phone:
      item.TEL_NO ||
      item.TEL ||
      item.PHONE ||
      "",

    lat,
    lon,

    shelterType:
      item.SHLT_SE_NM || "",
  };
}

// --------------------------------------------------
// ROUTING
// --------------------------------------------------

app.get(
  "/api/weather",
  async (req, res) => {
    try {
      const requestedAt = new Date();

      const current =
        await fetchLatest();

      let history = {};

      try {
        history =
          await fetchHistory();
      } catch (error) {
        history = {
          north: [],
          south: [],
          east: [],
          west: [],
        };
      }

      res.json({
        success: true,

        requestedAt:
          formatDisplayTime(
            requestedAt
          ),

        updatedAt:
          current.length > 0
            ? current[0].observedAt
            : formatKmaTime(
                requestedAt
              ),

        source: "AWS 관측자료",
        model: "KMA2006",

        data: current,
        regions: current,
        history,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }
);

// 안전자원 (쉼터/병원/보건소) API
app.get(
  "/api/resources",
  async (req, res) => {
    console.log(
      "🏥 안전자원 API 요청 수신"
    );

    const response = {
      success: true,
      hospital: [],
      healthCenter: [],
      shelter: [],
      shelterTotalDisplay: 781,
      errors: [],
    };

    // 병원 + 보건소
    // 공식 병의원 POI API 하나에서 함께 받음
    try {
      const medicalRaw =
        await fetchSafetyApiData(
          "/V2/api/DSSP-IF-00128",
          HOSPITAL_API_KEY ||
            HEALTH_CENTER_API_KEY
        );

      const medicalJeju =
        medicalRaw
          .map(mapMedicalResource)
          .filter((item) =>
            isJejuCoordinate(
              item.lat,
              item.lon
            )
          );

      response.hospital =
        medicalJeju.filter(
          (item) =>
            item.type === "hospital"
        );

      response.healthCenter =
        medicalJeju.filter(
          (item) =>
            item.type ===
            "healthCenter"
        );

      console.log(
        `🏥 병의원 POI 원본: ${medicalRaw.length}, 제주 병원: ${response.hospital.length}, 제주 보건소: ${response.healthCenter.length}`
      );
    } catch (error) {
      console.error(
        "❌ 병원/보건소 API 오류:",
        error.message
      );

      response.errors.push(
        `병원/보건소: ${error.message}`
      );
    }

    // 무더위쉼터
    try {
      const shelterRaw =
        await fetchSafetyApiData(
          "/V2/api/DSSP-IF-10942",
          SHELTER_API_KEY
        );

      response.shelter =
        shelterRaw
          .map(mapShelterResource)
          .filter((item) =>
            isJejuCoordinate(
              item.lat,
              item.lon
            )
          );

      console.log(
        `🏠 무더위쉼터 원본: ${shelterRaw.length}, 제주 쉼터: ${response.shelter.length}`
      );
    } catch (error) {
      console.error(
        "❌ 무더위쉼터 API 오류:",
        error.message
      );

      response.errors.push(
        `무더위쉼터: ${error.message}`
      );
    }

    console.log(
      `📊 최종 조회 수치 - 병원: ${response.hospital.length}, 보건소: ${response.healthCenter.length}, 쉼터: ${response.shelter.length}`
    );

    res.json(response);
  }
);

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      success: true,
      server: "JEJU HEAT GUARD",
      status: "running",
      time: new Date().toISOString(),
    });
  }
);

app.get(
  "/",
  (req, res) => {
    res.sendFile(
      __dirname + "/index.html"
    );
  }
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log("");
    console.log(
      "========================================"
    );
    console.log(
      "🔥 JEJU HEAT GUARD SERVER (AWS Model: KMA2006)"
    );
    console.log(
      `🌐 http://localhost:${PORT}`
    );
    console.log(
      "========================================"
    );
  }
);