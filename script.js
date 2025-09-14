// Golf overlay script
(function () {
  const DATA_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ6aWHCjlRHWl-HFOCcGJnBPhUD6--IbIQWpfXqmhNL-4K5ay9UdHWXyQc2fmMGBPh_f4dRDjsBlzMf/pub?gid=298849976&single=true&output=csv';
  const CURRENT_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ6aWHCjlRHWl-HFOCcGJnBPhUD6--IbIQWpfXqmhNL-4K5ay9UdHWXyQc2fmMGBPh_f4dRDjsBlzMf/pub?gid=74658754&single=true&output=csv';
  const REFRESH_MS = Number(new URLSearchParams(location.search).get('ms') || 5_000); // default 5s; override with ?ms=
  const HARD_RELOAD_MS = Number(new URLSearchParams(location.search).get('reloadMs') || 300_000); // default 5min; override with ?reloadMs=

  const elBody = document.getElementById('board-body');
  const elHole = document.getElementById('hole-number');
  const elPar = document.getElementById('hole-par');
  const elHoleTL = document.getElementById('tl-hole-number');
  const elParTL = document.getElementById('tl-hole-par');
  const elDesc = document.getElementById('desc-text');
  const elLastUpdated = document.getElementById('last-updated');
  const elHeaderDate = document.getElementById('header-date');
  const elHeaderTime = document.getElementById('header-time');
  const elBanner = document.getElementById('banner-img');

  // URL params allow simple customization (e.g., ?desc=Augusta%20National)
  const params = new URLSearchParams(location.search);
  const defaultDesc = params.get('desc') || '골프장 이름';
  elDesc.textContent = defaultDesc;

  // Optional: use Google Sheets API for near real-time updates (bypasses publish cache)
  const SHEETS_API_KEY = params.get('apiKey') || params.get('key') || '';
  const SPREADSHEET_ID = params.get('sheetId') || params.get('id') || '';
  const APP_URL = params.get('appUrl') || '';
  const SINGLE_SHEET = (params.get('single') ?? params.get('singleSheet') ?? '1') !== '0';
  const PLAYERS_GID = Number(params.get('playersGid') || params.get('dataGid') || 298849976);
  const CURRENT_GID = Number(params.get('currentGid') || 74658754);
  const CONTROL_GID = Number(params.get('controlGid') || 0);
  const PLAYERS_RANGE = params.get('playersRange') || 'A:Z';
  const CURRENT_RANGE = params.get('currentRange') || 'A:Z';
  const CONTROL_RANGE = params.get('controlRange') || 'A:Z';
  const MONOTONIC_HOLE = (params.get('monotonicHole') ?? '1') !== '0';
  const STRICT_GS_MONOTONIC = (params.get('strictGs') ?? '0') !== '0'; // default off for speed
  const ENFORCE_STABLE_NAMES = (params.get('stableNames') ?? '0') === '1';
  const REQUIRE_COHERENCE = (params.get('coherent') ?? '0') === '1';
  const CONFIRM_SNAPSHOT = (params.get('confirm') ?? '0') !== '0'; // default off
  const STABILIZE = (params.get('stabilize') ?? '1') !== '0';
  const STABILIZE_CYCLES = Math.max(1, Number(params.get('stabilizeCycles') || 2));
  const STABILIZE_HEADER_CYCLES = Math.max(1, Number(params.get('stabilizeHeaderCycles') || 1));
  const CONFIRM_DELAY_MS = Number(params.get('confirmDelayMs') || 300);

  // Refresh loop control
  let isRefreshing = false;
  let nextTimer = null;
  let lastGoodPlayers = [];
  let lastGoodCurrent = null; // {hole, par, course}
  let pendingPlayers = new Map(); // name -> { spt, gs, seen }
  let pendingCurrent = null; // { hole, par, course, seen }

  function parseCSV(text) {
    const rows = [];
    // Strip potential UTF-8 BOM and normalise newlines
    const s = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let field = '';
    let row = [];
    let inQuotes = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') {
        if (inQuotes && s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        row.push(field);
        field = '';
      } else if (ch === '\n' && !inQuotes) {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
    row.push(field);
    rows.push(row);
    if (rows.length && rows[rows.length - 1].every(v => v === '')) rows.pop();
    return rows;
  }

  function rowsToObjects(rows) {
    if (!rows || rows.length === 0) return [];
    const header = rows[0].map(h => (h || '').trim());
    return rows.slice(1).map(r => {
      const o = {};
      header.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
      return o;
    });
  }

  function parseSPT(val) {
    if (val == null) return null;
    let s = String(val).trim();
    if (!s) return null;
    if (/^e(ven)?$/i.test(s)) return 0;
    s = s.replace(/[−—–]/g, '-').replace(/\+/g, '+');
    // Allow leading +
    const n = Number(s);
    if (Number.isFinite(n)) return n;
    // Fallback: remove non-numeric except leading sign
    const cleaned = s.replace(/[^0-9+\-.]/g, '');
    const nn = Number(cleaned);
    return Number.isFinite(nn) ? nn : null;
  }

  function formatSPT(n) {
    if (n == null) return '';
    if (n === 0) return '0';
    return n > 0 ? `+${n}` : String(n);
  }

  function pad2(n) { return n.toString().padStart(2, '0'); }
  function updateTimestamp(now = new Date()) {
    if (!elLastUpdated) return;
    const hh = pad2(now.getHours());
    const mm = pad2(now.getMinutes());
    const ss = pad2(now.getSeconds());
    elLastUpdated.textContent = `마지막 갱신 ${hh}:${mm}:${ss}`;
  }

  function updateHeaderDatetimeNY(now = new Date()) {
    const tz = 'America/New_York';
    // Extract month/day/weekday parts to insert "월", "일"
    const parts = new Intl.DateTimeFormat('ko-KR', { timeZone: tz, month: 'numeric', day: 'numeric', weekday: 'long' }).formatToParts(now);
    const month = parts.find(p => p.type === 'month')?.value || '';
    const day = parts.find(p => p.type === 'day')?.value || '';
    const weekday = parts.find(p => p.type === 'weekday')?.value || '';
    const dateLine = `${month}월 ${day}일 ${weekday}`;
    const timeLine = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).format(now).replace(/\s/g, '');
    if (elHeaderDate) elHeaderDate.textContent = dateLine;
    if (elHeaderTime) elHeaderTime.textContent = timeLine;
  }

  function toInt(val) {
    const n = parseInt(String(val), 10);
    return Number.isFinite(n) ? n : null;
  }

  function mergePlayersMonotonic(newPlayers, oldPlayers) {
    if (!STRICT_GS_MONOTONIC || !oldPlayers || oldPlayers.length === 0) return newPlayers;
    const mapOld = new Map(oldPlayers.map(p => [p.name, p]));
    return newPlayers.map(np => {
      const op = mapOld.get(np.name);
      if (!op) return np;
      const ng = Number(np.gs);
      const og = Number(op.gs);
      if (Number.isFinite(ng) && Number.isFinite(og)) {
        if (ng < og) return op; // prevent rollback
      }
      return np;
    });
  }

  function stabilizeCommitPlayers(newPlayers) {
    if (!STABILIZE || lastGoodPlayers.length === 0) {
      // Bootstrap or disabled: accept immediately (with optional GS monotonic merge)
      return mergePlayersMonotonic(newPlayers, lastGoodPlayers);
    }
    const nextMap = new Map(lastGoodPlayers.map(p => [p.name, { ...p }]));
    let anyCommit = false;
    for (const np of newPlayers) {
      const op = nextMap.get(np.name);
      const changed = !op || op.spt !== np.spt || op.gs !== np.gs;
      if (!changed) { pendingPlayers.delete(np.name); continue; }
      const pend = pendingPlayers.get(np.name);
      if (pend && pend.spt === np.spt && pend.gs === np.gs) {
        pend.seen += 1;
      } else {
        pendingPlayers.set(np.name, { spt: np.spt, gs: np.gs, seen: 1 });
      }
      const seen = (pendingPlayers.get(np.name)?.seen) || 0;
      if (seen >= STABILIZE_CYCLES) {
        const base = op || { name: np.name, spt: np.spt, gs: np.gs };
        base.spt = np.spt;
        base.gs = np.gs;
        nextMap.set(np.name, base);
        pendingPlayers.delete(np.name);
        anyCommit = true;
      }
    }
    // Optionally keep existing players even if missing in new snapshot to avoid flicker
    const committed = Array.from(nextMap.values());
    return mergePlayersMonotonic(committed, lastGoodPlayers);
  }

  function eqCurrent(a, b) {
    if (!a || !b) return false;
    return String(a.hole||'') === String(b.hole||'') && String(a.par||'') === String(b.par||'') && String(a.course||'') === String(b.course||'');
  }

  function fetchCSV(url) {
    const bust = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
    return fetch(bust, {
      cache: 'no-store',
      redirect: 'follow',
      mode: 'cors',
      credentials: 'omit',
    }).then(r => r.text());
  }

  // Sheets API helpers (optional fast path)
  async function fetchWithRetry(url, opts = {}, retries = 2) {
    for (let i = 0; i <= retries; i++) {
      const bust = (url.includes('?') ? '&' : '?') + 'ts=' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      const res = await fetch(url + bust, { cache: 'no-store', redirect: 'follow', mode: 'cors', credentials: 'omit', ...opts });
      if (res.ok) return res;
      if (i === retries) throw new Error('HTTP ' + res.status);
      await new Promise(r => setTimeout(r, 250 + Math.random() * 400));
    }
  }
  let sheetTitleByGid = null; // cached mapping
  async function getSheetTitleMap() {
    if (sheetTitleByGid) return sheetTitleByGid;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}?fields=sheets(properties(sheetId,title))&key=${encodeURIComponent(SHEETS_API_KEY)}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error('Sheets API meta error ' + res.status);
    const json = await res.json();
    const map = {};
    (json.sheets || []).forEach(s => {
      const id = s?.properties?.sheetId;
      const title = s?.properties?.title;
      if (typeof id === 'number' && title) map[id] = title;
    });
    sheetTitleByGid = map;
    return map;
  }

  async function fetchValuesByTitle(title, range) {
    const rng = encodeURIComponent(`${title}!${range}`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}/values/${rng}?valueRenderOption=UNFORMATTED_VALUE&key=${encodeURIComponent(SHEETS_API_KEY)}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error('Sheets API values error ' + res.status);
    const json = await res.json();
    return json.values || [];
  }

  async function fetchBatchValues(playersTitle, playersRange, currentTitle, currentRange, controlTitle, controlRange) {
    const r1 = encodeURIComponent(`${playersTitle}!${playersRange}`);
    const r2 = encodeURIComponent(`${currentTitle}!${currentRange}`);
    const r3 = controlTitle ? encodeURIComponent(`${controlTitle}!${controlRange}`) : null;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&ranges=${r1}&ranges=${r2}${r3 ? `&ranges=${r3}` : ''}&key=${encodeURIComponent(SHEETS_API_KEY)}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error('Sheets API batch error ' + res.status);
    const json = await res.json();
    const valueRanges = json.valueRanges || [];
    return valueRanges.map(v => v.values || []);
  }

  async function fetchSnapshot(titleMap) {
    const playersTitle = titleMap[PLAYERS_GID];
    const currentTitle = titleMap[CURRENT_GID];
    const controlTitle = titleMap[CONTROL_GID];
    if (!playersTitle) throw new Error('Cannot resolve players sheet title');
    let playersValues = [];
    let currentValues = [];
    let controlValues = [];
    if (SINGLE_SHEET) {
      // Only read players sheet; current will be derived from its rows
      playersValues = await fetchValuesByTitle(playersTitle, PLAYERS_RANGE);
    } else {
      try {
        const arr = await fetchBatchValues(playersTitle, PLAYERS_RANGE, currentTitle, CURRENT_RANGE, controlTitle, CONTROL_RANGE);
        playersValues = arr[0] || [];
        currentValues = arr[1] || [];
        controlValues = arr[2] || [];
      } catch (e) {
        const promises = [
          fetchValuesByTitle(playersTitle, PLAYERS_RANGE),
          fetchValuesByTitle(currentTitle, CURRENT_RANGE)
        ];
        if (controlTitle) promises.push(fetchValuesByTitle(controlTitle, CONTROL_RANGE));
        const arr2 = await Promise.all(promises);
        playersValues = arr2[0] || [];
        currentValues = arr2[1] || [];
        controlValues = arr2[2] || [];
      }
    }
    return { playersValues, currentValues, controlValues };
  }

  function signatureFor(players, current) {
    const head = `${current.current_hole || current.hole || ''}|${current.current_par || current.par || ''}|${current.golf_course || current['golf course'] || current.course || ''}`;
    const body = players.map(p => `${p.name}|${p.spt}|${p.gs}`).join(';');
    return head + '||' + body;
  }

  function shallowEqualPlayers(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const p = a[i], q = b[i];
      if (!p || !q) return false;
      if (p.name !== q.name) return false;
      if (p.spt !== q.spt) return false;
      if (p.gs !== q.gs) return false;
    }
    return true;
  }

  function extractCurrentFromControl(values) {
    // Supports either key/value in columns titled 'title'/'data' or row with 'current' TRUE.
    if (!values || !values.length) return null;
    const header = values[0].map(x => (x || '').toString().trim());
    const titleIdx = header.findIndex(h => /^(title)$/i.test(h));
    const dataIdx = header.findIndex(h => /^(data)$/i.test(h));
    if (titleIdx !== -1 && dataIdx !== -1) {
      const map = {};
      for (let i = 1; i < values.length; i++) {
        const row = values[i] || [];
        const k = (row[titleIdx] || '').toString().trim();
        const v = (row[dataIdx] || '').toString().trim();
        if (k) map[k] = v;
      }
      const hole = (map.current_hole || map.hole || '').toString();
      const par = (map.current_par || map.par || '').toString();
      return (hole || par) ? { hole, par } : null;
    }
    // Fallback: look for column named 'current' with TRUE, then read first two columns as hole/par
    const curIdx = header.findIndex(h => /^current$/i.test(h));
    const holeIdx = header.findIndex(h => /^hole$/i.test(h));
    const parIdx = header.findIndex(h => /^par$/i.test(h));
    if (curIdx !== -1 && (holeIdx !== -1 || parIdx !== -1)) {
      for (let i = 1; i < values.length; i++) {
        const row = values[i] || [];
        const cur = String(row[curIdx] ?? '').toLowerCase();
        if (cur === 'true' || cur === '1') {
          const hole = row[holeIdx] != null ? String(row[holeIdx]) : '';
          const par = row[parIdx] != null ? String(row[parIdx]) : '';
          return { hole, par };
        }
      }
    }
    return null;
  }

  function rowsToObjectsFromValues(values) {
    if (!values || !values.length) return [];
    const header = values[0].map(h => (h || '').trim());
    return values.slice(1).map(r => {
      const o = {};
      header.forEach((h, i) => { o[h] = (r[i] ?? '').toString().trim(); });
      return o;
    });
  }

  function extractCurrentFromMergedRows(rows) {
    if (!rows || rows.length === 0) return null;
    const pairCounts = new Map(); // key: h|p
    const holeCounts = new Map();
    const parCounts = new Map();
    const courseCounts = new Map();
    for (const r of rows) {
      const h = toInt(r.current_hole ?? r.hole ?? null);
      const p = toInt(r.current_par ?? r.par ?? null);
      const c = (r.golf_course || r['golf course'] || r.golfCourse || r.course || '').toString().trim();
      if (h != null || p != null) {
        const key = `${h ?? ''}|${p ?? ''}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
      if (h != null) holeCounts.set(h, (holeCounts.get(h) || 0) + 1);
      if (p != null) parCounts.set(p, (parCounts.get(p) || 0) + 1);
      if (c) courseCounts.set(c, (courseCounts.get(c) || 0) + 1);
    }
    let bestH = null, bestP = null;
    if (pairCounts.size) {
      let bestKey = null, bestCnt = -1;
      for (const [k, cnt] of pairCounts.entries()) {
        if (cnt > bestCnt) { bestCnt = cnt; bestKey = k; }
        else if (cnt === bestCnt) {
          // tie-breaker: prefer larger hole number
          const [kh] = k.split('|');
          const [bh] = (bestKey || '|').split('|');
          const kih = toInt(kh), bih = toInt(bh);
          if ((kih ?? -1) > (bih ?? -1)) bestKey = k;
        }
      }
      const [kh, kp] = (bestKey || '|').split('|');
      bestH = toInt(kh); bestP = toInt(kp);
    } else {
      // fallbacks
      if (holeCounts.size) bestH = [...holeCounts.entries()].sort((a,b)=>b[1]-a[1] || (a[0]-b[0]))[0][0];
      if (parCounts.size) bestP = [...parCounts.entries()].sort((a,b)=>b[1]-a[1] || (a[0]-b[0]))[0][0];
    }
    const course = courseCounts.size ? [...courseCounts.entries()].sort((a,b)=>b[1]-a[1])[0][0] : '';
    if (bestH == null && bestP == null && !course) return null;
    return { current_hole: bestH != null ? String(bestH) : '', current_par: bestP != null ? String(bestP) : '', golf_course: course };
  }

  // Optional: Apps Script Web App JSON endpoint for fully consistent snapshot
  async function fetchAppSnapshot() {
    const url = APP_URL + (APP_URL.includes('?') ? '&' : '?') + 'ts=' + Date.now();
    const res = await fetch(url, { cache: 'no-store', mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error('App URL error ' + res.status);
    const json = await res.json();
    // Expected shape:
    // { players: [{name, spt, gs}], current: { current_hole, current_par, golf_course }, sig?: string }
    const players = Array.isArray(json.players) ? json.players : [];
    const current = json.current || {};
    return { players, current, sig: json.sig || '' };
  }

  function computeDenseRanks(players) {
    let lastSPT = null;
    let rank = 0;
    for (const p of players) {
      if (p.spt == null || !Number.isFinite(p.spt)) {
        p.rank = '';
        continue;
      }
      if (lastSPT === null || p.spt !== lastSPT) {
        rank += 1;
        lastSPT = p.spt;
      }
      p.rank = rank;
    }
    return players;
  }

  function renderBoard(players) {
    // Clear
    elBody.innerHTML = '';
    const frag = document.createDocumentFragment();
    players.forEach(p => {
      const row = document.createElement('div');
      row.className = 'row';
      // Rank
      const cRank = document.createElement('div');
      cRank.className = 'col rank';
      cRank.textContent = String(p.rank);
      // Name
      const cName = document.createElement('div');
      cName.className = 'col name';
      cName.textContent = p.name || '';
      // SPT
      const cSPT = document.createElement('div');
      cSPT.className = 'col spt';
      const sptVal = p.spt;
      if (sptVal == null || !Number.isFinite(sptVal)) {
        cSPT.textContent = '';
      } else {
        const badge = document.createElement('span');
        badge.className = 'spt-badge';
        badge.textContent = formatSPT(sptVal);
        if (sptVal > 0) badge.classList.add('pos');
        else if (sptVal < 0) badge.classList.add('neg');
        else badge.classList.add('zero');
        cSPT.appendChild(badge);
      }
      // GS
      const cGS = document.createElement('div');
      cGS.className = 'col gs';
      cGS.textContent = p.gs ?? '';
      row.append(cRank, cName, cSPT, cGS);
      frag.appendChild(row);
    });
    elBody.appendChild(frag);
  }

  async function refresh() {
    if (isRefreshing) return; // avoid overlap
    isRefreshing = true;
    try {
      let dataRows = [];
      let currentRows = [];
      let updatedOk = false;

      if (APP_URL) {
        // Use Apps Script (or custom) JSON endpoint if provided: most consistent + fastest
        const snap = await fetchAppSnapshot();
        dataRows = (snap.players || []).map(p => ({ name: p.name, SPT: p.spt, GS: p.gs }));
        currentRows = [snap.current || {}];
        var controlCur = null;
      } else if (SHEETS_API_KEY && SPREADSHEET_ID) {
        // Fast path using Sheets API (batch) — consistent snapshot and minimal quota.
        const titleMap = await getSheetTitleMap();
        let snap1 = await fetchSnapshot(titleMap);
        let dataRows1 = rowsToObjectsFromValues(snap1.playersValues);
        let currentRows1 = SINGLE_SHEET ? [] : rowsToObjectsFromValues(snap1.currentValues);
        let controlCur1 = extractCurrentFromControl(snap1.controlValues);

        if (CONFIRM_SNAPSHOT) {
          await new Promise(r => setTimeout(r, Math.max(0, CONFIRM_DELAY_MS)));
          const snap2 = await fetchSnapshot(titleMap);
          const dataRows2 = rowsToObjectsFromValues(snap2.playersValues);
          const currentRows2 = SINGLE_SHEET ? [] : rowsToObjectsFromValues(snap2.currentValues);
          let cur1 = currentRows1[0] || {};
          let cur2 = currentRows2[0] || {};
          if (SINGLE_SHEET) {
            cur1 = extractCurrentFromMergedRows(dataRows1) || {};
            cur2 = extractCurrentFromMergedRows(dataRows2) || {};
          }
          const sig1 = signatureFor(dataRows1.map(r=>({name:r.name,spt:parseSPT(r.SPT??r.spt??r.to_par??r.ToPar??r.스코어??''),gs:r.GS??r.gs??r.gross??r.합계??''})), cur1);
          const sig2 = signatureFor(dataRows2.map(r=>({name:r.name,spt:parseSPT(r.SPT??r.spt??r.to_par??r.ToPar??r.스코어??''),gs:r.GS??r.gs??r.gross??r.합계??''})), cur2);
          if (sig1 !== sig2) {
            // Prefer the newer snapshot (snap2)
            snap1 = snap2;
            dataRows1 = dataRows2;
            currentRows1 = currentRows2;
            controlCur1 = extractCurrentFromControl(snap2.controlValues);
          }
        }

        dataRows = dataRows1;
        if (SINGLE_SHEET) {
          const mergedCur = extractCurrentFromMergedRows(dataRows1);
          currentRows = mergedCur ? [mergedCur] : [];
        } else {
          currentRows = currentRows1;
        }
        var controlCur = controlCur1;
      } else {
        // Fallback to published CSV (subject to 5-min cache)
        if (SINGLE_SHEET) {
          const dataCsv = await fetchCSV(DATA_URL);
          dataRows = rowsToObjects(parseCSV(dataCsv));
          const mergedCur = extractCurrentFromMergedRows(dataRows);
          currentRows = mergedCur ? [mergedCur] : [];
        } else {
          const [dataCsv, currentCsv] = await Promise.all([
            fetchCSV(DATA_URL),
            fetchCSV(CURRENT_URL)
          ]);
          dataRows = rowsToObjects(parseCSV(dataCsv));
          currentRows = rowsToObjects(parseCSV(currentCsv));
        }
      }

      // Map players
      const players = dataRows
        .map(r => ({
          name: r.name || r.player || r.Player || r.이름 || '',
          sptRaw: r.SPT ?? r.spt ?? r.to_par ?? r.ToPar ?? r.스코어 ?? '',
          gsRaw: r.GS ?? r.gs ?? r.gross ?? r.합계 ?? ''
        }))
        .filter(p => p.name && String(p.name).trim() !== '')
        .map(p => ({
          name: p.name.trim(),
          spt: parseSPT(p.sptRaw),
          gs: (p.gsRaw || '').trim()
        }));

      // Sort by SPT ascending; place null/NaN at the bottom. If both null, sort by name.
      players.sort((a, b) => {
        const aa = (a.spt == null || !Number.isFinite(a.spt)) ? Infinity : a.spt;
        const bb = (b.spt == null || !Number.isFinite(b.spt)) ? Infinity : b.spt;
        if (aa !== bb) return aa - bb;
        return a.name.localeCompare(b.name);
      });

      // Only apply UI update when data looks sane; otherwise keep last successful render.
      const minPlayers = Number(params.get('minPlayers') || 1);
      const looksSane = players.length >= minPlayers;
      const stableNames = (function(){
        if (!lastGoodPlayers.length) return true;
        const a = new Set(players.map(p=>p.name));
        const b = new Set(lastGoodPlayers.map(p=>p.name));
        if (a.size !== b.size) return false;
        for (const n of a) if (!b.has(n)) return false;
        return true;
      })();
      const passGuards = looksSane && (!ENFORCE_STABLE_NAMES || stableNames);
      if (passGuards) {
        const committed = stabilizeCommitPlayers(players);
        lastGoodPlayers = committed;
        computeDenseRanks(committed);
        renderBoard(committed);
        updatedOk = true;
      } else if (lastGoodPlayers.length > 0) {
        computeDenseRanks(lastGoodPlayers);
        renderBoard(lastGoodPlayers);
      }

      // Update header and description atomically using currentRows (+control coherence if required)
      if (currentRows && currentRows.length > 0) {
        const cur = currentRows[0];
        const hole = (cur.current_hole || cur.hole || '').toString();
        const par = (cur.current_par || cur.par || '').toString();
        const course = (cur.golf_course || cur['golf course'] || cur.golfCourse || cur.course || cur.description || cur.desc || '').toString().trim();
        // If strict coherence requested, require control==current; otherwise prefer current, then stabilize over N cycles and apply monotonic guard.
        if (REQUIRE_COHERENCE && typeof controlCur === 'object' && controlCur) {
          const ch = (controlCur.hole || '').toString();
          const cp = (controlCur.par || '').toString();
          if ((ch && hole && ch !== hole) || (cp && par && cp !== par)) {
            // mismatch detected; keep last good to avoid flicker
          } else {
            const newHole = hole || ch;
            const newPar = par || cp;
            // Enforce monotonic non-decreasing hole to avoid rollbacks
            if (MONOTONIC_HOLE && lastGoodCurrent && toInt(newHole) != null && toInt(lastGoodCurrent.hole) != null && toInt(newHole) < toInt(lastGoodCurrent.hole)) {
              // ignore hole rollback
            } else {
              const candidate = { hole: newHole, par: newPar, course };
              if (!STABILIZE) { lastGoodCurrent = candidate; updatedOk = true; }
              else {
                if (pendingCurrent && eqCurrent(pendingCurrent, candidate)) {
                  pendingCurrent.seen += 1;
                } else {
                  pendingCurrent = { ...candidate, seen: 1 };
                }
                if (!lastGoodCurrent) { lastGoodCurrent = candidate; updatedOk = true; pendingCurrent = null; }
                else if (pendingCurrent.seen >= STABILIZE_HEADER_CYCLES) { lastGoodCurrent = candidate; updatedOk = true; pendingCurrent = null; }
              }
            }
          }
        } else {
          if (MONOTONIC_HOLE && lastGoodCurrent && toInt(hole) != null && toInt(lastGoodCurrent.hole) != null && toInt(hole) < toInt(lastGoodCurrent.hole)) {
            // ignore hole rollback
          } else {
            const candidate = { hole, par, course };
            if (!STABILIZE) { lastGoodCurrent = candidate; updatedOk = true; }
            else {
              if (pendingCurrent && eqCurrent(pendingCurrent, candidate)) {
                pendingCurrent.seen += 1;
              } else {
                pendingCurrent = { ...candidate, seen: 1 };
              }
              if (!lastGoodCurrent) { lastGoodCurrent = candidate; updatedOk = true; pendingCurrent = null; }
              else if (pendingCurrent.seen >= STABILIZE_HEADER_CYCLES) { lastGoodCurrent = candidate; updatedOk = true; pendingCurrent = null; }
            }
          }
        }
      }

      if (lastGoodCurrent) {
        const { hole, par, course } = lastGoodCurrent;
        if (hole) {
          elHole.textContent = hole;
          if (elHoleTL) elHoleTL.textContent = hole;
        }
        if (par) {
          const label = `PAR ${par}`;
          elPar.textContent = label;
          if (elParTL) elParTL.textContent = label;
        }
        if (course) elDesc.textContent = course;
      }

      if (updatedOk) updateTimestamp();
    } catch (err) {
      // Non-fatal; keep overlay running
      // Optional: show minimal inline error state
      console.error('Overlay refresh error', err);
    }
    finally {
      isRefreshing = false;
      clearTimeout(nextTimer);
      nextTimer = setTimeout(refresh, REFRESH_MS);
    }
  }

  // Initial load, then interval
  refresh();
  // Update header NY time regularly
  updateHeaderDatetimeNY();
  setInterval(updateHeaderDatetimeNY, 1_000);

  // Rotating banner (two images, 10s loop)
  function setupBannerRotation() {
    if (!elBanner) return;
    const defaults = [
      '1JquVOGqPf6aCL4hwL2jgKg6zgOtcxZeY',
      '1JbbABA7_ePBkGlnBCDBDs6KLz2qIbavK'
    ];

    const fromParams = [];
    const pIds = (params.get('bannerIds') || '').split(',').map(s => s.trim()).filter(Boolean);
    const b1 = params.get('banner1') || '';
    const b2 = params.get('banner2') || '';
    const lone = params.get('banner') || '';
    const loneId = params.get('bannerId') || '';

    function extractIdFromDriveUrl(u) {
      try {
        const m = String(u).match(/\/file\/d\/([^/]+)\//);
        return m ? m[1] : null;
      } catch { return null; }
    }

    function asSource(s) {
      if (!s) return null;
      if (/^https?:\/\//i.test(s)) {
        const id = extractIdFromDriveUrl(s);
        if (id) return { primary: `https://lh3.googleusercontent.com/d/${id}=w340-h100`, fallback: `https://drive.google.com/uc?export=view&id=${id}` };
        return { primary: s, fallback: s };
      }
      // assume drive id
      return { primary: `https://lh3.googleusercontent.com/d/${s}=w340-h100`, fallback: `https://drive.google.com/uc?export=view&id=${s}` };
    }

    // Build list in priority order
    const candidates = [];
    if (pIds.length) candidates.push(...pIds);
    if (b1) candidates.push(b1);
    if (b2) candidates.push(b2);
    if (lone || loneId) candidates.push(lone || loneId);
    if (candidates.length === 0) candidates.push(...defaults);

    const sources = candidates
      .map(c => asSource(c))
      .filter(Boolean);
    if (sources.length === 0) return;

    let idx = 0;
    function apply(i) {
      const src = sources[i % sources.length];
      elBanner.loading = 'lazy';
      elBanner.decoding = 'async';
      elBanner.referrerPolicy = 'no-referrer';
      elBanner.onerror = () => {
        if (elBanner.src !== src.fallback) elBanner.src = src.fallback;
        else elBanner.onerror = null;
      };
      elBanner.src = src.primary;
    }

    // First apply immediately, then rotate every 10s
    apply(idx);
    setInterval(() => { idx = (idx + 1) % sources.length; apply(idx); }, 10_000);
  }

  setupBannerRotation();

  // Hard reload every 5 minutes to avoid any long-lived cache drift
  setInterval(() => {
    try { console.debug && console.debug('Hard reload tick'); } catch {}
    location.reload();
  }, HARD_RELOAD_MS);
})();
