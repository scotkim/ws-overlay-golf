// Golf overlay script
(function () {
  const DATA_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ6aWHCjlRHWl-HFOCcGJnBPhUD6--IbIQWpfXqmhNL-4K5ay9UdHWXyQc2fmMGBPh_f4dRDjsBlzMf/pub?gid=298849976&single=true&output=csv';
  const CURRENT_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ6aWHCjlRHWl-HFOCcGJnBPhUD6--IbIQWpfXqmhNL-4K5ay9UdHWXyQc2fmMGBPh_f4dRDjsBlzMf/pub?gid=74658754&single=true&output=csv';
  const REFRESH_MS = 10_000; // 10 seconds

  const elBody = document.getElementById('board-body');
  const elHole = document.getElementById('hole-number');
  const elPar = document.getElementById('hole-par');
  const elHoleTL = document.getElementById('tl-hole-number');
  const elParTL = document.getElementById('tl-hole-par');
  const elDesc = document.getElementById('desc-text');

  // URL params allow simple customization (e.g., ?desc=Augusta%20National)
  const params = new URLSearchParams(location.search);
  const defaultDesc = params.get('desc') || '골프장 이름';
  elDesc.textContent = defaultDesc;

  // Optional: use Google Sheets API for near real-time updates (bypasses publish cache)
  const SHEETS_API_KEY = params.get('apiKey') || params.get('key') || '';
  const SPREADSHEET_ID = params.get('sheetId') || params.get('id') || '';
  const PLAYERS_GID = Number(params.get('playersGid') || params.get('dataGid') || 298849976);
  const CURRENT_GID = Number(params.get('currentGid') || 74658754);
  const PLAYERS_RANGE = params.get('playersRange') || 'A:C';
  const CURRENT_RANGE = params.get('currentRange') || 'A:Z';

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
  let sheetTitleByGid = null; // cached mapping
  async function getSheetTitleMap() {
    if (sheetTitleByGid) return sheetTitleByGid;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}?fields=sheets(properties(sheetId,title))&key=${encodeURIComponent(SHEETS_API_KEY)}`;
    const res = await fetch(url, { cache: 'no-store', mode: 'cors', credentials: 'omit' });
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
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}/values/${rng}?key=${encodeURIComponent(SHEETS_API_KEY)}`;
    const res = await fetch(url, { cache: 'no-store', mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error('Sheets API values error ' + res.status);
    const json = await res.json();
    return json.values || [];
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

      if (SHEETS_API_KEY && SPREADSHEET_ID) {
        // Fast path using Sheets API (no 5-min publish cache)
        const titleMap = await getSheetTitleMap();
        const playersTitle = titleMap[PLAYERS_GID];
        const currentTitle = titleMap[CURRENT_GID];
        if (!playersTitle || !currentTitle) throw new Error('Cannot resolve sheet titles from gid');
        const [playersValues, currentValues] = await Promise.all([
          fetchValuesByTitle(playersTitle, PLAYERS_RANGE),
          fetchValuesByTitle(currentTitle, CURRENT_RANGE)
        ]);
        dataRows = rowsToObjectsFromValues(playersValues);
        currentRows = rowsToObjectsFromValues(currentValues);
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

      // Only apply UI update when we have a non-empty players list;
      // otherwise keep last successful render to avoid flicker/partial draws.
      if (players.length > 0) {
        lastGoodPlayers = players;
        computeDenseRanks(players);
        renderBoard(players);
      } else if (lastGoodPlayers.length > 0) {
        computeDenseRanks(lastGoodPlayers);
        renderBoard(lastGoodPlayers);
      }

      // Update header and description atomically using currentRows
      if (currentRows && currentRows.length > 0) {
        const cur = currentRows[0];
        const hole = (cur.current_hole || cur.hole || '').toString();
        const par = (cur.current_par || cur.par || '').toString();
        const course = (cur.golf_course || cur['golf course'] || cur.golfCourse || cur.course || cur.description || cur.desc || '').toString().trim();
        lastGoodCurrent = { hole, par, course };
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
