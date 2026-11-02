/**
 * RED Cleaner - background service worker
 */

importScripts('update.js');

const STORE_KEY = 'redcleaner.captured';

// 최후의 수단. queryId 는 X 가 배포할 때마다 바뀌므로 신뢰하지 않는다.
// 우선순위: 실제 요청 관찰(observed) > JS 번들 추출(bundle) > 아래 값(fallback)
const FALLBACK_QUERY_IDS = {
  DeleteTweet: 'nxpZCY2K-I6QoFHAHeojFQ',
  DeleteRetweet: 'ZyZigVsNiFO6v1dEks1eWg'
};

const TIMELINE_OP_RE = /^User(Tweets|TweetsAndReplies|ArticlesTweets)$/;

/**
 * 캡처 경로로 어느 탭인지 구분한다. 경로를 모르면 오퍼레이션 이름으로 추정.
 * path 는 "pathname + search" 형태(예: "/user/media?filter=photo"). 미디어 탭은
 * ?filter=photo 유무로 영상 전용 목록과 사진 전용 목록이 나뉘므로 쿼리까지 봐야 한다.
 */
function kindOf(path, operation) {
  if (path) {
    const qIdx = path.indexOf('?');
    const pathname = qIdx === -1 ? path : path.slice(0, qIdx);
    const search = qIdx === -1 ? '' : path.slice(qIdx + 1);

    if (/\/with_replies\/?$/.test(pathname)) return 'replies';
    if (/\/reposts\/?$/.test(pathname)) return 'reposts';
    if (/\/media\/?$/.test(pathname)) {
      return /(?:^|&)filter=photo(?:&|$)/.test(search) ? 'mediaPhoto' : 'media';
    }
    if (/\/(highlights|likes)\/?$/.test(pathname)) return null; // 쓰지 않는 탭
    return 'tweets'; // 프로필 루트 또는 /all
  }
  if (operation === 'UserTweetsAndReplies') return 'replies';
  if (operation === 'UserTweets') return 'tweets';
  if (operation === 'UserMedia') return 'media';
  return null;
}

function emptyCapture() {
  return {
    authorization: null,
    clientUuid: null,
    platform: null,
    timelinesByUser: {},
    queryIds: { ...FALLBACK_QUERY_IDS },
    queryIdSource: {}, // { OperationName: 'observed' | 'bundle' }
    tids: {}, // { OperationName: x-client-transaction-id }
    lastTid: null,
    capturedAt: 0
  };
}

let captured = emptyCapture();
let loaded = false;

async function load() {
  if (loaded) return;
  try {
    const got = await chrome.storage.local.get(STORE_KEY);
    const saved = got && got[STORE_KEY];
    if (saved) {
      captured = {
        ...emptyCapture(),
        ...saved,
        timelinesByUser: { ...(saved.timelinesByUser || {}) },
        queryIds: { ...FALLBACK_QUERY_IDS, ...(saved.queryIds || {}) },
        queryIdSource: { ...(saved.queryIdSource || {}) },
        tids: { ...(saved.tids || {}) }
      };
      delete captured.timelines;
      // 형식이 다르면 버린다.
      for (const bucket of Object.values(captured.timelinesByUser)) {
        for (const key of Object.keys(bucket)) {
          if (
            key !== 'tweets' &&
            key !== 'replies' &&
            key !== 'reposts' &&
            key !== 'media' &&
            key !== 'mediaPhoto'
          )
            delete bucket[key];
        }
      }
    }
  } catch (e) {
    /* noop */
  }
  loaded = true;
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ [STORE_KEY]: captured }).catch(() => {});
  }, 250);
}

function parseGraphql(url) {
  const m = String(url || '').match(/\/graphql\/([^/?]+)\/([^/?#]+)/);
  return m ? { queryId: m[1], operation: m[2] } : null;
}

/**
 * 한 건의 관찰 결과를 반영. 바뀐 게 있으면 true.
 * @param {'page'|'webrequest'} source
 * @param {string|null} userId 캡처 당시 로그인된 계정. 모르면 null('*' 버킷에 보관)
 */
function absorb(url, operation, queryId, headers, path, source, isTimeline, userId) {
  let dirty = false;

  if (operation && queryId && captured.queryIds[operation] !== queryId) {
    captured.queryIds[operation] = queryId;
    captured.queryIdSource[operation] = 'observed'; // 실제 요청이 가장 확실하다
    dirty = true;
  } else if (operation && queryId) {
    captured.queryIdSource[operation] = 'observed';
  }

  const timelineish = isTimeline || (operation && TIMELINE_OP_RE.test(operation));
  if (timelineish && url) {
    const kind = kindOf(path, operation);
    if (kind) {
      const bucketKey = userId || '*';
      if (!captured.timelinesByUser[bucketKey]) captured.timelinesByUser[bucketKey] = {};
      const bucket = captured.timelinesByUser[bucketKey];
      const prev = bucket[kind];
      const next = {
        op: operation,
        queryId,
        url,
        path: path || (prev && prev.path) || null,
        source,
        userId: userId || null,
        // 응답 구조로 확인된 진짜 타임라인인지
        confirmed: Boolean(isTimeline),
        at: Date.now()
      };

      // 밀려날 수 있다.
      const score = (e) => (e.confirmed ? 4 : 0) + (e.source === 'page' ? 2 : 0);

      if (!prev || score(next) > score(prev) || (score(next) === score(prev) && prev.url !== url)) {
        bucket[kind] = next;
        captured.capturedAt = Date.now();
        dirty = true;
      }
    }
  }

  for (const key of Object.keys(headers || {})) {
    const value = headers[key];
    if (!value) continue;
    switch (key.toLowerCase()) {
      case 'authorization':
        if (captured.authorization !== value) {
          captured.authorization = value;
          dirty = true;
        }
        break;
      case 'x-client-uuid':
        if (captured.clientUuid !== value) {
          captured.clientUuid = value;
          dirty = true;
        }
        break;
      case 'sec-ch-ua-platform':
        if (captured.platform !== value) {
          captured.platform = value;
          dirty = true;
        }
        break;
      case 'x-client-transaction-id':
        captured.lastTid = value;
        if (operation) captured.tids[operation] = value;
        dirty = true;
        break;
      default:
        break;
    }
  }

  return dirty;
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const gql = parseGraphql(details.url);
    if (!gql) return;

    const headers = {};
    for (const h of details.requestHeaders || []) headers[h.name.toLowerCase()] = h.value;

    let path = null;
    try {
      if (details.documentUrl) {
        const u = new URL(details.documentUrl);
        path = u.pathname + u.search;
      }
    } catch (e) {
      /* noop */
    }

    load().then(() => {
      if (absorb(details.url, gql.operation, gql.queryId, headers, path, 'webrequest', false)) {
        persist();
      }
    });
  },
  {
    urls: [
      '*://*.x.com/*graphql/*',
      '*://*.twitter.com/*graphql/*',
      '*://api.x.com/*',
      '*://api.twitter.com/*'
    ]
  },
  ['requestHeaders']
);

// -------------------------------------------- X JS 번들에서 queryId 추출

/**
 * X 웹앱 번들에는 { queryId: "...", operationName: "DeleteTweet" } 형태의 표가 들어 있다.
 * 이걸 읽으면 사용자가 수동으로 삭제해 보지 않아도 최신 queryId 를 알 수 있다.
 */
const scannedScripts = new Set();

async function scanBundles(urls) {
  const found = {};
  const targets = (urls || []).filter((u) => !scannedScripts.has(u)).slice(0, 60);

  for (const url of targets) {
    scannedScripts.add(url);
    try {
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) continue;
      const text = await res.text();

      const patterns = [
        /queryId\s*:\s*"([A-Za-z0-9_-]{15,})"\s*,\s*operationName\s*:\s*"(\w+)"/g,
        /operationName\s*:\s*"(\w+)"\s*,\s*queryId\s*:\s*"([A-Za-z0-9_-]{15,})"/g
      ];

      let m;
      while ((m = patterns[0].exec(text)) !== null) found[m[2]] = m[1];
      while ((m = patterns[1].exec(text)) !== null) found[m[1]] = m[2];
    } catch (e) {
      /* 개별 스크립트 실패는 무시 */
    }
  }

  let added = 0;
  for (const op of Object.keys(found)) {
    // 실제 요청으로 확인한 값이 있으면 그쪽이 우선
    if (captured.queryIdSource[op] === 'observed') continue;
    if (captured.queryIds[op] !== found[op]) {
      captured.queryIds[op] = found[op];
      captured.queryIdSource[op] = 'bundle';
      added += 1;
    }
  }
  if (added > 0) persist();

  return { added, total: Object.keys(found).length };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === 'rc-scan-queryids') {
    load()
      .then(() => scanBundles(message.urls))
      .then((r) => sendResponse({ ok: true, ...r, queryIds: captured.queryIds }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'rc-capture') {
    load().then(() => {
      const c = message.data || {};
      if (absorb(c.url, c.op, c.queryId, c.headers, c.path, 'page', c.isTimeline, c.userId)) persist();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'rc-get-captured') {
    load().then(() => sendResponse({ ok: true, captured }));
    return true;
  }

  if (message.type === 'rc-forget-timelines') {
    load().then(() => {
      captured.timelinesByUser = {};
      persist();
      sendResponse({ ok: true });
    });
    return true;
  }

  return false;
});
