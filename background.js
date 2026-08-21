/**
 * RED Cleaner - background service worker
 *
 * 두 경로로 X 의 GraphQL 요청 정보를 모은다.
 *  1) content.js 가 MAIN world 후킹으로 잡아 전달 (source: 'page') — 주 수단
 *  2) webRequest 로 관찰 (source: 'webrequest') — 보조
 *
 * 타임라인은 오퍼레이션 이름이 아니라 "어느 탭에서 나온 요청인가"(kind)로 보관한다.
 * X 가 /all 과 /with_replies 에 같은 오퍼레이션 이름을 쓰는 경우가 있어서,
 * 이름을 키로 쓰면 한쪽이 다른 쪽을 덮어써 버린다.
 *
 * storage.local 에 저장한다. storage.session 은 확장을 새로고침(↻)할 때
 * 통째로 날아가서 "아까는 잡았는데 지금은 없다"가 된다.
 */

importScripts('update.js');

const STORE_KEY = 'redcleaner.captured';

// 최후의 수단. queryId 는 X 가 배포할 때마다 바뀌므로 신뢰하지 않는다.
// 우선순위: 실제 요청 관찰(observed) > JS 번들 추출(bundle) > 아래 값(fallback)
const FALLBACK_QUERY_IDS = {
  DeleteTweet: 'nxpZCY2K-I6QoFHAHeojFQ',
  DeleteRetweet: 'ZyZigVsNiFO6v1dEks1eWg'
};

// 이름은 X 가 언제든 바꾸므로 보조 판정용일 뿐이다.
// 주 판정은 content.js 가 응답 구조를 보고 넘겨주는 isTimeline 플래그다.
const TIMELINE_OP_RE = /^User(Tweets|TweetsAndReplies|ArticlesTweets)$/;

/** 캡처 경로로 어느 탭인지 구분한다. 경로를 모르면 오퍼레이션 이름으로 추정. */
function kindOf(path, operation) {
  if (path) {
    if (/\/with_replies\/?$/.test(path)) return 'replies';
    if (/\/(media|highlights|likes)\/?$/.test(path)) return null; // 쓰지 않는 탭
    return 'tweets'; // 프로필 루트 또는 /all
  }
  if (operation === 'UserTweetsAndReplies') return 'replies';
  if (operation === 'UserTweets') return 'tweets';
  return null;
}

function emptyCapture() {
  return {
    authorization: null,
    clientUuid: null,
    platform: null,
    // { tweets: {...}, replies: {...} } — 값은 { op, queryId, url, path, source, at }
    timelines: {},
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
        timelines: { ...(saved.timelines || {}) },
        queryIds: { ...FALLBACK_QUERY_IDS, ...(saved.queryIds || {}) },
        queryIdSource: { ...(saved.queryIdSource || {}) },
        tids: { ...(saved.tids || {}) }
      };
      // 예전 버전은 오퍼레이션 이름을 키로 썼다. 형식이 다르면 버린다.
      for (const key of Object.keys(captured.timelines)) {
        if (key !== 'tweets' && key !== 'replies') delete captured.timelines[key];
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
 */
function absorb(url, operation, queryId, headers, path, source, isTimeline) {
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
      const prev = captured.timelines[kind];
      const next = {
        op: operation,
        queryId,
        url,
        path: path || (prev && prev.path) || null,
        source,
        // 응답 구조로 확인된 진짜 타임라인인지
        confirmed: Boolean(isTimeline),
        at: Date.now()
      };

      // 더 나은 캡처만 받아들인다. 점수가 높을수록 신뢰도가 높다.
      //  - 응답으로 확인된 것 > 이름만 맞는 것
      //  - 페이지 후킹(요청 시점 경로를 앎) > webRequest(SPA 라 경로가 낡음)
      //  - "/all" 에서 잡은 것 > 프로필 루트에서 잡은 것
      const score = (e) =>
        (e.confirmed ? 4 : 0) +
        (e.source === 'page' ? 2 : 0) +
        (/\/all\/?$/.test(e.path || '') ? 1 : 0);

      if (!prev || score(next) > score(prev) || (score(next) === score(prev) && prev.url !== url)) {
        captured.timelines[kind] = next;
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
      if (details.documentUrl) path = new URL(details.documentUrl).pathname;
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
      if (absorb(c.url, c.op, c.queryId, c.headers, c.path, 'page', c.isTimeline)) persist();
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
      captured.timelines = {};
      persist();
      sendResponse({ ok: true });
    });
    return true;
  }

  return false;
});
