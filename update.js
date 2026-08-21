/**
 * RED Cleaner - GitHub 업데이트 확인
 *
 * 압축해제 확장은 스토어처럼 자동 설치가 안 되므로,
 * 최신 버전을 감지해서 배지·배너로 알리고 릴리스 페이지로 안내한다.
 *
 * 확인 순서: releases/latest → tags → 기본 브랜치의 manifest.json
 */

const UPDATE_KEY = 'redcleaner.update';
const DEFAULT_REPO = 'RED-Cleaner/beta';
const CHECK_INTERVAL_MINUTES = 360; // 6시간

function parseVersion(v) {
  return String(v || '')
    .trim()
    .replace(/^v/i, '')
    .split(/[.\-+]/)
    .map((n) => parseInt(n, 10))
    .filter((n) => Number.isFinite(n));
}

/** a > b 면 1, 같으면 0, 작으면 -1 */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    const l = x[i] || 0;
    const r = y[i] || 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}

async function getUpdateState() {
  const got = await chrome.storage.local.get(UPDATE_KEY);
  const saved = got[UPDATE_KEY] || {};
  return {
    repo: DEFAULT_REPO,
    repoSetByUser: false,
    lastCheck: 0,
    lastError: null,
    latest: null, // { version, url, name, publishedAt, source }
    dismissed: null,
    ...saved,
    // 사용자가 직접 지정한 적이 없으면 항상 최신 기본값을 쓴다.
    repo: saved.repoSetByUser && saved.repo ? saved.repo : DEFAULT_REPO
  };
}

async function setUpdateState(patch) {
  const current = await getUpdateState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [UPDATE_KEY]: next });
  return next;
}

async function ghJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/vnd.github+json' },
    cache: 'no-store'
  });
  if (res.status === 404) return null;
  if (res.status === 403) throw new Error('GitHub API 요청 한도에 걸렸습니다. 잠시 후 다시 시도하세요.');
  if (!res.ok) throw new Error(`GitHub 응답 오류 (HTTP ${res.status})`);
  return res.json();
}

/** 저장소에서 최신 버전 정보를 찾는다. 못 찾으면 null */
async function fetchLatest(repo) {
  const base = `https://api.github.com/repos/${repo}`;

  // 1) 정식 릴리스
  const release = await ghJson(`${base}/releases/latest`);
  if (release && release.tag_name) {
    return {
      version: release.tag_name,
      url: release.html_url,
      name: release.name || release.tag_name,
      publishedAt: release.published_at || null,
      source: 'release'
    };
  }

  // 2) 태그
  const tags = await ghJson(`${base}/tags?per_page=20`);
  if (Array.isArray(tags) && tags.length > 0) {
    const newest = tags
      .filter((t) => parseVersion(t.name).length > 0)
      .sort((a, b) => compareVersions(b.name, a.name))[0];
    if (newest) {
      return {
        version: newest.name,
        url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(newest.name)}`,
        name: newest.name,
        publishedAt: null,
        source: 'tag'
      };
    }
  }

  // 3) 기본 브랜치의 manifest.json
  const repoInfo = await ghJson(base);
  if (!repoInfo) throw new Error(`저장소를 찾을 수 없습니다: ${repo}`);
  const branch = repoInfo.default_branch || 'main';
  const file = await ghJson(`${base}/contents/manifest.json?ref=${encodeURIComponent(branch)}`);
  if (file && file.content) {
    try {
      const json = JSON.parse(atob(file.content.replace(/\n/g, '')));
      if (json.version) {
        return {
          version: json.version,
          url: `https://github.com/${repo}`,
          name: `${branch} 브랜치`,
          publishedAt: null,
          source: 'manifest'
        };
      }
    } catch (e) {
      /* 파싱 실패는 무시 */
    }
  }

  return null;
}

// 경로 정규화
function normalizeRepo(input) {
  const cleaned = String(input || '')
    .trim()
    .replace(/^git@github\.com:/i, '')
    .replace(/^https?:\/\/(?:www\.)?(?:api\.|raw\.|codeload\.|gist\.)?github(?:usercontent)?\.com\//i, '')
    .replace(/^repos\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/^\/+/, '');

  // 앞 두 세그먼트만 저장소를 가리킨다. (archive/refs/heads/main.zip 등은 버린다)
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length < 2) return '';
  const owner = parts[0];
  const name = parts[1].replace(/\.git$/i, '').replace(/\.zip$/i, '');
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return '';
  return `${owner}/${name}`;
}

function currentVersion() {
  return chrome.runtime.getManifest().version;
}

async function applyBadge(state) {
  const has = state.latest && compareVersions(state.latest.version, currentVersion()) > 0;
  const hidden = has && state.dismissed && compareVersions(state.dismissed, state.latest.version) >= 0;

  try {
    await chrome.action.setBadgeText({ text: has && !hidden ? 'NEW' : '' });
    if (has && !hidden) {
      await chrome.action.setBadgeBackgroundColor({ color: '#e0245e' });
      await chrome.action.setTitle({
        title: `RED Cleaner — 새 버전 ${state.latest.version} 있음`
      });
    } else {
      await chrome.action.setTitle({ title: 'RED Cleaner' });
    }
  } catch (e) {
    /* noop */
  }
}

/** @param {boolean} force 캐시 무시하고 즉시 확인 */
async function checkForUpdate(force = false) {
  const state = await getUpdateState();

  if (!force && Date.now() - state.lastCheck < 60 * 60 * 1000) {
    return summarize(state);
  }

  try {
    const latest = await fetchLatest(state.repo);
    const next = await setUpdateState({
      latest,
      lastCheck: Date.now(),
      lastError: latest ? null : '저장소에 릴리스나 태그가 없습니다.'
    });
    await applyBadge(next);
    return summarize(next);
  } catch (err) {
    const next = await setUpdateState({ lastCheck: Date.now(), lastError: err.message });
    await applyBadge(next);
    return summarize(next);
  }
}

function summarize(state) {
  const current = currentVersion();
  const latest = state.latest;
  const hasUpdate = Boolean(latest) && compareVersions(latest.version, current) > 0;
  return {
    repo: state.repo,
    current,
    latest,
    hasUpdate,
    dismissed: Boolean(
      hasUpdate && state.dismissed && compareVersions(state.dismissed, latest.version) >= 0
    ),
    lastCheck: state.lastCheck,
    lastError: state.lastError
  };
}

// ------------------------------------------------------------ 배선

chrome.alarms.create('redcleaner-update-check', {
  delayInMinutes: 1,
  periodInMinutes: CHECK_INTERVAL_MINUTES
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'redcleaner-update-check') checkForUpdate(false);
});

chrome.runtime.onInstalled.addListener(() => {
  checkForUpdate(true);
});

chrome.runtime.onStartup.addListener(() => {
  checkForUpdate(false);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === 'rc-update-status') {
    checkForUpdate(Boolean(message.force))
      .then((info) => sendResponse({ ok: true, info }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'rc-update-dismiss') {
    getUpdateState()
      .then((s) => setUpdateState({ dismissed: s.latest ? s.latest.version : null }))
      .then((s) => applyBadge(s))
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'rc-update-set-repo') {
    const repo = normalizeRepo(message.repo);
    if (!repo) {
      sendResponse({ ok: false, error: '형식이 올바르지 않습니다. 예) 사용자명/저장소명' });
      return false;
    }
    setUpdateState({
      repo,
      repoSetByUser: repo !== DEFAULT_REPO,
      latest: null,
      dismissed: null,
      lastCheck: 0,
      lastError: null
    })
      .then(() => checkForUpdate(true))
      .then((info) => sendResponse({ ok: true, info }));
    return true;
  }

  return false;
});
