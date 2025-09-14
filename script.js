// Golf overlay script
(function () {
  const DATA_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ6aWHCjlRHWl-HFOCcGJnBPhUD6--IbIQWpfXqmhNL-4K5ay9UdHWXyQc2fmMGBPh_f4dRDjsBlzMf/pub?gid=298849976&single=true&output=csv';
  const CURRENT_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ6aWHCjlRHWl-HFOCcGJnBPhUD6--IbIQWpfXqmhNL-4K5ay9UdHWXyQc2fmMGBPh_f4dRDjsBlzMf/pub?gid=74658754&single=true&output=csv';
  const REFRESH_MS = 6_000; // 6 seconds per request

  const elBody = document.getElementById('board-body');
  const elHole = document.getElementById('hole-number');
  const elPar = document.getElementById('hole-par');
  const elHoleTL = document.getElementById('tl-hole-number');
  const elParTL = document.getElementById('tl-hole-par');
  const elDesc = document.getElementById('desc-text');
  const elLastUpdated = document.getElementById('last-updated');

  // URL params allow simple customization (e.g., ?desc=Augusta%20National)
  const params = new URLSearchParams(location.search);
  const defaultDesc = params.get('desc') || '골프장 이름';
  elDesc.textContent = defaultDesc;

  // Optional: use Google Sheets API for near real-time updates (bypasses publish cache)
  const SHEETS_API_KEY = params.get('apiKey') || params.get('key') || '';
  const SPREADSHEET_ID = params.get('sheetId') || params.get('id') || '';
  const PLAYERS_GID = Number(params.get('playersGid') || params.get('dataGid') || 298849976);
  const CURRENT_GID = Number(params.get('currentGid') || 74658754);
  const CONTROL_GID = Number(params.get('controlGid') || 0);
  const PLAYERS_RANGE = params.get('playersRange') || 'A:C';
  const CURRENT_RANGE = params.get('currentRange') || 'A:Z';
  const CONTROL_RANGE = params.get('controlRange') || 'A:Z';
  const MONOTONIC_HOLE = (params.get('monotonicHole') ?? '1') !== '0';
  const STRICT_GS_MONOTONIC = (params.get('strictGs') ?? '1') !== '0';

  // Refresh loop control
  let isRefreshing = false;
  let nextTimer = null;
  let lastGoodPlayers = [];
  let lastGoodCurrent = null; // {hole, par, course}

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
    if (n === 0) return 'E';
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
      cSPT.textContent = formatSPT(p.spt);
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

      if (SHEETS_API_KEY && SPREADSHEET_ID) {
        // Fast path using Sheets API (batch) — consistent snapshot and minimal quota.
        const titleMap = await getSheetTitleMap();
        const playersTitle = titleMap[PLAYERS_GID];
        const currentTitle = titleMap[CURRENT_GID];
        const controlTitle = titleMap[CONTROL_GID];
        if (!playersTitle || !currentTitle) throw new Error('Cannot resolve sheet titles from gid');
        let playersValues = [];
        let currentValues = [];
        let controlValues = [];
        try {
          const arr = await fetchBatchValues(playersTitle, PLAYERS_RANGE, currentTitle, CURRENT_RANGE, controlTitle, CONTROL_RANGE);
          playersValues = arr[0] || [];
          currentValues = arr[1] || [];
          controlValues = arr[2] || [];
        } catch (e) {
          // Fallback to individual calls if batch fails
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
        dataRows = rowsToObjectsFromValues(playersValues);
        currentRows = rowsToObjectsFromValues(currentValues);
        var controlCur = extractCurrentFromControl(controlValues);
      } else {
        // Fallback to published CSV (subject to 5-min cache)
        const [dataCsv, currentCsv] = await Promise.all([
          fetchCSV(DATA_URL),
          fetchCSV(CURRENT_URL)
        ]);
        dataRows = rowsToObjects(parseCSV(dataCsv));
        currentRows = rowsToObjects(parseCSV(currentCsv));
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
      if (looksSane && stableNames) {
        // Optionally enforce non-decreasing GS to avoid stale rollbacks
        const merged = mergePlayersMonotonic(players, lastGoodPlayers);
        lastGoodPlayers = merged;
        computeDenseRanks(merged);
        renderBoard(merged);
        updatedOk = true;
      } else if (lastGoodPlayers.length > 0) {
        computeDenseRanks(lastGoodPlayers);
        renderBoard(lastGoodPlayers);
      }

      // Update header and description atomically using currentRows (+control coherence if present)
      if (currentRows && currentRows.length > 0) {
        const cur = currentRows[0];
        const hole = (cur.current_hole || cur.hole || '').toString();
        const par = (cur.current_par || cur.par || '').toString();
        const course = (cur.golf_course || cur['golf course'] || cur.golfCourse || cur.course || cur.description || cur.desc || '').toString().trim();
        // If control provides a view of current hole/par, require match to avoid transient flips.
        if (typeof controlCur === 'object' && controlCur) {
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
              lastGoodCurrent = { hole: newHole, par: newPar, course };
              updatedOk = true;
            }
          }
        } else {
          if (MONOTONIC_HOLE && lastGoodCurrent && toInt(hole) != null && toInt(lastGoodCurrent.hole) != null && toInt(hole) < toInt(lastGoodCurrent.hole)) {
            // ignore hole rollback
          } else {
            lastGoodCurrent = { hole, par, course };
            updatedOk = true;
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
})();
