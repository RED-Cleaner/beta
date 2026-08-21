/**
 * RED Cleaner - GitHub 업데이트 확인
 *
 * 압축해제 확장은 스토어처럼 자동 설치가 안 되므로,
 * 최신 버전을 감지해서 배지·배너로 알리고 릴리스 페이지로 안내한다.
 *
 * 확인 순서: releases/latest 리다이렉트 → tags.atom → raw manifest.json (GitHub API 미사용)
 */

const UPDATE_KEY = 'redcleaner.update';
const DEFAULT_REPO = 'RED-Cleaner/beta';
const CHECK_INTERVAL_MINUTES = 1440; // 24시간

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
    lastCheck: 0,
    lastError: null,
    latest: null, // { version, url, name, publishedAt, source }
    dismissed: null,
    ...saved,
    // 저장소는 고정이다. 사용자가 바꿀 수 없다.
    repo: DEFAULT_REPO
  };
}

async function setUpdateState(patch) {
  const current = await getUpdateState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [UPDATE_KEY]: next });
  return next;
}

/** 리다이렉트를 따라간 최종 주소와 본문을 준다. 없으면 null */
async function ghFetch(url) {
  const res = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  if (res.status === 404) return null;
  if (res.status === 429) throw new Error('요청이 너무 잦습니다. 잠시 후 다시 시도하세요.');
  if (!res.ok) throw new Error(`GitHub 응답 오류 (HTTP ${res.status})`);
  return { url: res.url, text: await res.text() };
}

/**
 * 저장소에서 최신 버전 정보를 찾는다. 못 찾으면 null.
 *   1) /releases/latest 리다이렉트 주소에서 태그 읽기
 *   2) /tags.atom 피드
 *   3) raw.githubusercontent.com 의 manifest.json
 */
async function fetchLatest(repo) {
  const home = `https://github.com/${repo}`;
  let repoExists = false;

  // 1) /releases/latest 는 최신 릴리스 태그 페이지로 리다이렉트된다.
  const latestPage = await ghFetch(`${home}/releases/latest`);
  if (latestPage) {
    repoExists = true;
    const m = latestPage.url.match(/\/releases\/tag\/([^/?#]+)/);
    if (m) {
      const version = decodeURIComponent(m[1]);
      const title = (latestPage.text.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
      return {
        version,
        url: latestPage.url,
        name: title.split('·')[0].trim() || version,
        publishedAt: (latestPage.text.match(/datetime="([^"]+)"/) || [])[1] || null,
        source: 'release'
      };
    }
  }

  // 2) 태그 피드 (릴리스를 안 만들고 태그만 찍는 경우)
  const tagsFeed = await ghFetch(`${home}/tags.atom`);
  if (tagsFeed) {
    repoExists = true;
    const names = [...tagsFeed.text.matchAll(/<title>([^<]+)<\/title>/g)]
      .map((m) => m[1].trim())
      .filter((n) => parseVersion(n).length > 0);
    const newest = names.sort((a, b) => compareVersions(b, a))[0];
    if (newest) {
      return {
        version: newest,
        url: `${home}/releases/tag/${encodeURIComponent(newest)}`,
        name: newest,
        publishedAt: null,
        source: 'tag'
      };
    }
  }

  // 3) 기본 브랜치(HEAD)의 manifest.json
  const raw = await ghFetch(`https://raw.githubusercontent.com/${repo}/HEAD/manifest.json`);
  if (raw) {
    repoExists = true;
    try {
      const json = JSON.parse(raw.text);
      if (json.version) {
        return {
          version: json.version,
          url: `${home}/archive/refs/heads/main.zip`,
          name: 'manifest.json',
          publishedAt: null,
          source: 'manifest'
        };
      }
    } catch (e) {
      /* 파싱 실패는 무시 */
    }
  }

  if (!repoExists) throw new Error(`저장소를 찾을 수 없습니다: ${repo}`);
  return null;
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

  return false;
});
