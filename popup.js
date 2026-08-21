/* RED Cleaner - popup */

const FIELDS = {
  checkbox: [
    't-tweets',
    't-replies',
    't-retweets',
    'mentionsOnly',
    'keepThreads',
    'keepPinned',
    'keepMedia',
    'keepFavorited',
    'useMinLikes',
    'useMinRetweets',
    'dryRun'
  ],
  value: [
    'minLikes',
    'minRetweets',
    'excludeKeywords',
    'excludeIds',
    'afterDate',
    'beforeDate',
    'batchSize',
    'cooldownMinutes',
    'deleteDelayMs',
    'maxDeletions'
  ]
};

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ 테마
// popup.html <head> 인라인 스크립트가 깜빡임 없이 초기 테마를 이미 세팅해 둔다.
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('theme-toggle').textContent = theme === 'light' ? '🌙' : '☀️';
}

applyTheme(document.documentElement.dataset.theme);

$('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem('rc-theme', next);
  applyTheme(next);
});

const el = {
  ready: $('ready'),
  notice: $('notice'),
  captured: $('captured-text'),
  phase: $('phase'),
  body: document.querySelector('.body'),
  log: $('log'),
  start: $('start'),
  stop: $('stop'),
  tabsRow: $('tabs-row'),
  openAll: $('open-all'),
  openReplies: $('open-replies')
};

let myScreenName = null;

let activeTab = null;
let contentReady = false;

// ------------------------------------------------------------ 설정 저장

function readConfig() {
  const cfg = {
    targets: {
      tweets: $('t-tweets').checked,
      replies: $('t-replies').checked,
      retweets: $('t-retweets').checked
    }
  };
  for (const id of FIELDS.checkbox) {
    if (id.startsWith('t-')) continue;
    cfg[id] = $(id).checked;
  }
  for (const id of FIELDS.value) cfg[id] = $(id).value;
  return cfg;
}

function applyConfig(cfg) {
  if (!cfg) return;
  if (cfg.targets) {
    $('t-tweets').checked = !!cfg.targets.tweets;
    $('t-replies').checked = !!cfg.targets.replies;
    $('t-retweets').checked = !!cfg.targets.retweets;
  }
  for (const id of FIELDS.checkbox) {
    if (id.startsWith('t-')) continue;
    if (typeof cfg[id] === 'boolean') $(id).checked = cfg[id];
  }
  for (const id of FIELDS.value) {
    if (cfg[id] !== undefined && cfg[id] !== null) $(id).value = cfg[id];
  }
}

function saveConfig() {
  chrome.storage.local.set({ 'redcleaner.config': readConfig() });
}

// ------------------------------------------------------------ 유틸

function showNotice(text) {
  if (!text) {
    el.notice.classList.add('hidden');
    return;
  }
  el.notice.textContent = text;
  el.notice.classList.remove('hidden');
}

function isX(url) {
  return /^https:\/\/([a-z0-9-]+\.)?(x|twitter)\.com\//.test(url || '');
}

function sendToTab(message) {
  return new Promise((resolve) => {
    if (!activeTab) return resolve(null);
    chrome.tabs.sendMessage(activeTab.id, message, (res) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(res);
    });
  });
}

// ------------------------------------------------------------ 상태 표시

const PHASE_TEXT = {
  idle: '대기 중',
  scanning: '타임라인 확인 중',
  deleting: '정리 중',
  cooldown: '휴식 중',
  ratelimited: '요청 제한 대기 중',
  done: '완료',
  error: '오류'
};

let logShown = 0; // 팝업이 지금까지 받아 그린 로그 개수
let isRunning = false;

/** 폴링을 기다리지 않고 즉시 반영되도록 따로 뺐다. */
function updateStartLabel(running) {
  if (typeof running === 'boolean') isRunning = running;
  const dry = $('dryRun').checked;
  el.start.textContent = isRunning ? '실행 중…' : dry ? '미리보기 시작' : '삭제 시작';
  el.start.classList.toggle('btn-danger', !dry);
  el.start.classList.toggle('btn-safe', dry);
}

function isNearBottom(elm, threshold = 40) {
  return elm.scrollHeight - elm.scrollTop - elm.clientHeight < threshold;
}

function appendLog(entries) {
  const stick = isNearBottom(el.body);

  const frag = document.createDocumentFragment();
  for (const entry of entries) {
    const d = document.createElement('div');
    d.className = `k-${entry.kind}`;
    d.textContent = `${new Date(entry.t).toTimeString().slice(0, 8)}  ${entry.text}`;
    frag.appendChild(d);
  }
  el.log.appendChild(frag);

  // 화면에 남기는 줄 수도 제한한다.
  while (el.log.childElementCount > 300) el.log.removeChild(el.log.firstChild);
  if (stick) el.body.scrollTop = el.body.scrollHeight;
}

function renderState(s) {
  if (!s) return;

  $('s-scanned').textContent = s.scanned;
  $('s-deleted').textContent = s.deleted;
  $('s-skipped').textContent = s.skipped;
  $('s-failed').textContent = s.failed;

  let phase = PHASE_TEXT[s.phase] || s.phase;
  if (s.pass) phase += ` · ${s.pass}`;
  if (s.message) phase += ` · ${s.message}`;
  if (s.cooldownUntil > Date.now()) {
    const left = Math.ceil((s.cooldownUntil - Date.now()) / 1000);
    phase += ` (${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')})`;
  }
  el.phase.textContent = phase;

  if (s.logReset || s.logTotal < logShown) el.log.innerHTML = '';
  if (s.log.length > 0) appendLog(s.log);
  logShown = s.logTotal;

  el.start.disabled = s.running || !contentReady;
  el.stop.disabled = !s.running;
  updateStartLabel(s.running);
}

// ------------------------------------------------------------ 업데이트

function sendToBg(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (r) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(r);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

const REPO = 'RED-Cleaner/beta'; // 고정. 변경 불가
let updateInfo = null;

function renderUpdate(info) {
  updateInfo = info;
  const banner = $('update-banner');
  const note = $('update-info');

  if (!info) {
    note.textContent = '업데이트 정보를 가져오지 못했습니다.';
    banner.classList.add('hidden');
    return;
  }

  const when = info.lastCheck
    ? new Date(info.lastCheck).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })
    : '아직 없음';

  if (info.lastError) {
    note.textContent = `현재 v${info.current} · ${info.lastError}`;
  } else if (info.hasUpdate) {
    note.textContent = `현재 v${info.current} → 최신 ${info.latest.version} · 확인 ${when}`;
  } else if (info.latest) {
    note.textContent = `현재 v${info.current} · 최신 버전입니다 · 확인 ${when}`;
  } else {
    note.textContent = `현재 v${info.current} · 확인 ${when}`;
  }

  if (info.hasUpdate && !info.dismissed) {
    $('update-title').textContent = `새 버전 ${info.latest.version} 이 있습니다`;
    $('update-sub').textContent =
      info.latest.source === 'manifest'
        ? '기본 브랜치 기준 · 내려받아 폴더를 교체한 뒤 확장을 새로고침하세요.'
        : '내려받아 폴더를 교체한 뒤 확장을 새로고침하세요.';
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

async function loadUpdate(force = false) {
  if (force) $('update-info').textContent = '확인 중…';
  const res = await sendToBg({ type: 'rc-update-status', force });
  renderUpdate(res && res.ok ? res.info : null);
}

$('update-check').addEventListener('click', () => loadUpdate(true));

// 캐시된 타임라인 정보가 이상할 때 비우고 다시 잡게 한다.
$('captured-reset').addEventListener('click', async () => {
  await sendToBg({ type: 'rc-forget-timelines' });
  showNotice('타임라인 정보를 비웠습니다. 트윗 탭 → 전체, 답글 탭을 각각 다시 열어주세요.');
  await detectTab();
});

$('update-hide').addEventListener('click', async () => {
  await sendToBg({ type: 'rc-update-dismiss' });
  $('update-banner').classList.add('hidden');
});

$('update-open').addEventListener('click', () => {
  if (updateInfo && updateInfo.latest) chrome.tabs.create({ url: updateInfo.latest.url });
});

$('repo-save').addEventListener('click', () => {
  const repo = (updateInfo && updateInfo.repo) || REPO;
  chrome.tabs.create({ url: `https://github.com/${repo}/archive/refs/heads/main.zip` });
});

$('repo-open').addEventListener('click', () => {
  const repo = (updateInfo && updateInfo.repo) || REPO;
  chrome.tabs.create({ url: `https://github.com/${repo}` });
});

// ------------------------------------------------------------ 초기화

async function detectTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;
  $('captured').classList.add('hidden');
  el.tabsRow.classList.add('hidden');
  myScreenName = null;

  if (!tab || !isX(tab.url)) {
    contentReady = false;
    el.ready.textContent = 'x.com 아님';
    el.ready.className = 'badge badge-wait';
    showNotice('x.com 탭에서 열어주세요.');
    el.start.disabled = true;
    return;
  }

  const pinged = await sendToTab({ type: 'rc-status', logFrom: logShown });
  if (!pinged) {
    contentReady = false;
    el.ready.textContent = '탭 새로고침 필요';
    el.ready.className = 'badge badge-wait';
    showNotice('확장 프로그램을 설치·수정한 뒤에는 x.com 탭을 새로고침해야 합니다.');
    el.start.disabled = true;
    return;
  }

  const r = await sendToTab({ type: 'rc-ready' });
  const ready = r && r.ready;

  // x.com 탭일 때만 이동 버튼을 보여준다.
  if (ready && ready.screenName) {
    myScreenName = ready.screenName;
    el.tabsRow.classList.remove('hidden');
    el.openAll.classList.toggle('done', Boolean(ready.hasTweetsTab));
    el.openReplies.classList.toggle('done', Boolean(ready.hasRepliesTab));
    el.openAll.textContent = ready.hasTweetsTab ? '전체 트윗 ✓' : '전체 트윗 열기';
    el.openReplies.textContent = ready.hasRepliesTab ? '답글 탭 ✓' : '답글 탭 열기';
  }

  if (!ready || !ready.loggedIn) {
    contentReady = false;
    el.ready.textContent = '로그인 필요';
    el.ready.className = 'badge badge-wait';
    showNotice('x.com 에 로그인되어 있는지 확인하세요.');
  } else if (!ready.authorization) {
    contentReady = false;
    el.ready.textContent = '세션 대기';
    el.ready.className = 'badge badge-wait';
    showNotice(
      '아직 X 의 API 요청을 못 잡았습니다. 이 탭에서 내 프로필로 이동하거나 새로고침한 뒤 팝업을 다시 열어보세요.'
    );
  } else if (ready.timelines.length === 0) {
    contentReady = false;
    el.ready.textContent = '타임라인 대기';
    el.ready.className = 'badge badge-wait';
    showNotice('프로필 → 트윗 탭 → "전체", 그리고 프로필 → 답글 탭을 각각 한 번씩 열어주세요.');
  } else {
    contentReady = true;
    const both = ready.hasTweetsTab && ready.hasRepliesTab;
    el.ready.textContent = both ? '준비 완료' : '일부 준비';
    el.ready.className = 'badge ' + (both ? 'badge-ok' : 'badge-wait');
    showNotice(
      both
        ? ''
        : `아직 ${ready.hasTweetsTab ? '답글 탭' : '트윗 탭 → 전체'} 을(를) 못 잡았습니다. ` +
            '그 탭을 한 번 열면 그쪽도 정리 대상이 됩니다.'
    );
    el.captured.textContent = '잡은 타임라인: ' + ready.timelines.map((t) => t.label).join(', ');
    $('captured').classList.remove('hidden');
  }

  renderState(pinged.state);
}

let pollTimer = null;

async function poll() {
  const res = await sendToTab({ type: 'rc-status', logFrom: logShown });
  if (res) renderState(res.state);

  // 돌고 있을 때만 자주 물어본다.
  const running = Boolean(res && res.state && res.state.running);
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, running ? 700 : 2000);
}

// ------------------------------------------------------------ 이벤트

el.start.addEventListener('click', async () => {
  const cfg = readConfig();
  if (!cfg.targets.tweets && !cfg.targets.replies && !cfg.targets.retweets) {
    showNotice('삭제 대상(트윗(퍼블트) / 답글 / 리트윗)을 최소 하나 선택하세요.');
    return;
  }

  if (!cfg.dryRun) {
    const targets = [
      cfg.targets.tweets && '트윗(퍼블트)',
      cfg.targets.replies && '답글',
      cfg.targets.retweets && '리트윗'
    ]
      .filter(Boolean)
      .join(', ');

    const first = confirm(
      `⚠️ 삭제를 시작합니다\n\n` +
        `대상: ${targets}\n` +
        `한 번 지운 트윗은 복구할 수 없습니다.\n\n` + `(삭제 전 미리보기 모드 지원)`
    );
    if (!first) return;
  }

  saveConfig();
  const res = await sendToTab({ type: 'rc-start', config: cfg });
  if (!res || !res.ok) {
    showNotice(res?.error || '시작하지 못했습니다. 탭을 새로고침한 뒤 다시 시도하세요.');
    return;
  }
  showNotice('');
  el.log.innerHTML = '';
  logShown = 0;
  poll();
});

el.stop.addEventListener('click', async () => {
  await sendToTab({ type: 'rc-stop' });
  poll();
});

function goTo(suffix) {
  if (!myScreenName) {
    showNotice('내 계정을 확인하지 못했습니다. x.com 탭을 새로고침해 주세요.');
    return;
  }
  const url = `https://x.com/${myScreenName}${suffix}`;
  if (activeTab && isX(activeTab.url)) {
    chrome.tabs.update(activeTab.id, { url });
  } else {
    chrome.tabs.create({ url });
  }
  window.close();
}

el.openAll.addEventListener('click', () => goTo('/all'));
el.openReplies.addEventListener('click', () => goTo('/with_replies'));

for (const id of [...FIELDS.checkbox, ...FIELDS.value]) {
  $(id).addEventListener('change', saveConfig);
}

// 미리보기 토글은 버튼 라벨이 즉시 따라와야 한다.
$('dryRun').addEventListener('change', () => updateStartLabel());

// ------------------------------------------------------------ 부팅

(async () => {
  const stored = await chrome.storage.local.get('redcleaner.config');
  applyConfig(stored['redcleaner.config']);
  updateStartLabel(false);
  await detectTab();
  loadUpdate(false);
  poll();
})();
