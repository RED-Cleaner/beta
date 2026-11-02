/**
 * RED Cleaner - content script (실제 정리 엔진)
 *
 * x.com 페이지 컨텍스트에서 동작하며, 팝업이 닫혀도 계속 실행된다.
 * 팝업은 rc-status 로 상태를 폴링한다.
 */

(() => {
  if (window.__RED_CLEANER_LOADED__) return;
  window.__RED_CLEANER_LOADED__ = true;

  // 타임라인 분류·보관은 background.js 한 곳에서만 한다.
  // 여기서 잡은 캡처는 전부 background 로 넘기고, 필요할 때 병합된 결과를 받아 쓴다.
  function timelineLabel(kind, entry) {
    const path = (entry && entry.path) || '';
    if (kind === 'replies') return path ? `답글(${path})` : '답글';
    if (kind === 'reposts') return path ? `재게시(${path})` : '재게시';
    if (kind === 'media') return path ? `미디어-영상(${path})` : '미디어-영상';
    if (kind === 'mediaPhoto') return path ? `미디어-사진(${path})` : '미디어-사진';
    return path ? `게시물(${path})` : '게시물';
  }

  // ---------------------------------------------------- MAIN world 캡처

  // inject.js 가 후킹한 실제 GraphQL 요청 정보. background 가 잠들어 있어도
  // 바로 쓸 수 있게 헤더류만 여기 캐시한다.
  const local = {
    authorization: null,
    csrf: null,
    clientUuid: null,
    queryIds: {},
    tids: {},
    lastTid: null
  };

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__redCleaner !== 'capture') return;

    const h = d.headers || {};
    if (h.authorization) local.authorization = h.authorization;
    if (h['x-csrf-token']) local.csrf = h['x-csrf-token'];
    if (h['x-client-uuid']) local.clientUuid = h['x-client-uuid'];
    if (h['x-client-transaction-id']) {
      local.lastTid = h['x-client-transaction-id'];
      if (d.op) local.tids[d.op] = h['x-client-transaction-id'];
    }
    if (d.op && d.queryId) local.queryIds[d.op] = d.queryId;

    // 우리가 보낸 요청은 다시 백그라운드로 올릴 필요 없음
    if (d.url && d.url.indexOf('__rc=1') !== -1) return;

    // 어느 계정에서 잡은 캡처인지 같이 보낸다. 안 그러면 계정을 바꿔도
    // 이전 계정에서 잡은 타임라인이 "잡혀있다"고 잘못 표시된다.
    d.userId = getMyUserId();

    try {
      chrome.runtime.sendMessage({ type: 'rc-capture', data: d }, () => void chrome.runtime.lastError);
    } catch (e) {
      /* 확장 컨텍스트 무효화 시 무시 */
    }
  });

  // ---------------------------------------------------------------- 상태

  const state = {
    running: false,
    starting: false,
    stopRequested: false,
    phase: 'idle', // idle | scanning | deleting | cooldown | ratelimited | done | error
    pass: null,
    scanned: 0,
    matched: 0,
    deleted: 0,
    skipped: 0,
    failed: 0,
    batchCount: 0,
    cooldownUntil: 0,
    message: '',
    log: [],
    dryRun: false,
    startedAt: 0,
    finishedAt: 0
  };

  const MAX_LOG = 400;
  let logSeq = 0; // 누적 로그 개수 (잘려나간 것 포함)

  function log(text, kind = 'info') {
    state.log.push({ t: Date.now(), kind, text });
    logSeq += 1;
    if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
    if (kind === 'error') console.warn('[RED Cleaner]', text);
  }

  function setPhase(phase, message = '') {
    state.phase = phase;
    state.message = message;
    paintOverlay();
  }

  // ------------------------------------------------------------ 오버레이

  // 실행 중에는 페이지를 덮어 진행 상태를 보여주고, 사용자가 X 를 만져
  // 타임라인이 흔들리는 것도 막는다.
  const OVERLAY_ID = '__red_cleaner_overlay__';
  let overlay = null;
  let overlayTimer = null;

  function buildOverlay() {
    const root = document.createElement('div');
    root.id = OVERLAY_ID;
    root.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'background:rgba(0,0,0,0.82)',
      '-webkit-backdrop-filter:blur(2px)',
      'backdrop-filter:blur(2px)',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'font-family:-apple-system,"Segoe UI","Malgun Gothic",system-ui,sans-serif',
      'color:#e8e9ea',
      'cursor:default',
      'user-select:none'
    ].join(';');

    const box = document.createElement('div');
    box.style.cssText = 'text-align:center;padding:0 24px;max-width:520px';

    const bar = document.createElement('div');
    bar.style.cssText = 'width:44px;height:3px;background:#e0245e;margin:0 auto 22px';

    const title = document.createElement('div');
    title.dataset.rc = 'title';
    title.style.cssText =
      'font-size:30px;font-weight:700;letter-spacing:2px;line-height:1.3;margin-bottom:14px';

    const sub = document.createElement('div');
    sub.dataset.rc = 'sub';
    sub.style.cssText = 'font-size:13px;color:#9aa2ad;line-height:1.7;font-variant-numeric:tabular-nums';

    const stop = document.createElement('button');
    stop.dataset.rc = 'stop';
    stop.textContent = '중지';
    stop.style.cssText = [
      'margin-top:26px',
      'padding:10px 30px',
      'background:#1f2126',
      'border:none',
      'border-radius:0',
      'color:#e8e9ea',
      'font:inherit',
      'font-size:13px',
      'font-weight:600',
      'cursor:pointer'
    ].join(';');
    stop.addEventListener('click', () => {
      state.stopRequested = true;
      log('중지 요청됨…', 'info');
      paintOverlay();
    });

    box.append(bar, title, sub, stop);
    root.appendChild(box);
    return root;
  }

  function paintOverlay() {
    if (!overlay) return;

    const waiting = state.phase === 'cooldown' || state.phase === 'ratelimited';
    const title = overlay.querySelector('[data-rc="title"]');
    const sub = overlay.querySelector('[data-rc="sub"]');
    const stop = overlay.querySelector('[data-rc="stop"]');

    title.textContent = state.stopRequested ? '정리를 멈추는 중' : waiting ? '대기중' : '트윗 청소중';

    const lines = [];
    if (waiting && state.cooldownUntil > Date.now()) {
      const left = Math.ceil((state.cooldownUntil - Date.now()) / 1000);
      const mm = String(Math.floor(left / 60)).padStart(2, '0');
      const ss = String(left % 60).padStart(2, '0');
      lines.push(
        `${state.phase === 'ratelimited' ? '요청 제한 해제까지' : '다음 배치까지'} ${mm}:${ss}`
      );
    } else if (state.message) {
      lines.push(state.message);
    }
    lines.push(
      `처리 ${state.deleted} · 보존 ${state.skipped} · 검사 ${state.scanned}` +
        (state.failed ? ` · 실패 ${state.failed}` : '')
    );
    if (state.dryRun) lines.push('미리보기 모드 — 실제로 지우지 않습니다');
    lines.push('이 창을 닫거나 새로고침하면 중단됩니다');

    sub.textContent = '';
    lines.forEach((text, i) => {
      if (i > 0) sub.appendChild(document.createElement('br'));
      sub.appendChild(document.createTextNode(text));
    });

    stop.textContent = state.stopRequested ? '중지 중…' : '중지';
    stop.disabled = state.stopRequested;
    stop.style.opacity = state.stopRequested ? '0.5' : '1';
  }

  function showOverlay() {
    if (overlay && overlay.isConnected) return;
    overlay = buildOverlay();
    // body 는 X 가 다시 그릴 수 있어서 documentElement 에 붙인다.
    document.documentElement.appendChild(overlay);
    paintOverlay();
    clearInterval(overlayTimer);
    overlayTimer = setInterval(paintOverlay, 500);
  }

  function hideOverlay() {
    clearInterval(overlayTimer);
    overlayTimer = null;
    if (overlay && overlay.isConnected) overlay.remove();
    overlay = null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function interruptibleSleep(ms) {
    // 탭이 백그라운드에 5분 이상 있으면 Chrome 이 반복 타이머 깨우기를
    // 분당 1회로 강제 조인다(Intensive Throttling). 짧은 간격으로 수백~수천 번
    // 깨우면 그만큼 밀려서, 화면 카운트다운은 0:00인데 실제로는 한참 더 걸린다.
    // 깨우는 횟수 자체를 최소화해서 영향을 줄인다.
    const step = 15000;
    let left = ms;
    while (left > 0 && !state.stopRequested) {
      await sleep(Math.min(step, left));
      left -= step;
    }
  }

  // ---------------------------------------------------------- 세션 정보

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function getMyUserId() {
    const twid = getCookie('twid'); // "u=1234567890"
    if (!twid) return null;
    const m = twid.match(/u%3D(\d+)|u=(\d+)/);
    return m ? m[1] || m[2] : null;
  }

  function getMyScreenName() {
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (link) {
      const name = (link.getAttribute('href') || '').replace(/^\//, '').split('/')[0];
      if (name) return name;
    }
    const m = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})(\/|$)/);
    return m ? m[1] : null;
  }

  /** 페이지가 로드한 X 번들 스크립트 목록 */
  function bundleScriptUrls() {
    const out = new Set();
    try {
      for (const e of performance.getEntriesByType('resource')) {
        if (/^https:\/\/abs\.twimg\.com\/.+\.js(\?|$)/.test(e.name)) out.add(e.name);
      }
    } catch (e) {
      /* noop */
    }
    for (const s of document.querySelectorAll('script[src]')) {
      if (/^https:\/\/abs\.twimg\.com\/.+\.js/.test(s.src)) out.add(s.src);
    }
    return [...out];
  }

  /** X 번들에서 최신 queryId 를 긁어온다. */
  async function refreshQueryIds() {
    const urls = bundleScriptUrls();
    if (urls.length === 0) return null;
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'rc-scan-queryids', urls }, (r) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(r && r.ok ? r : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  /** 백그라운드(webRequest) + 로컬(MAIN world) 캡처 병합. 로컬 우선. */
  async function buildSession() {
    const res = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'rc-get-captured' }, (r) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(r);
        });
      } catch (e) {
        resolve(null);
      }
    });

    const bg = (res && res.captured) || {};
    const byUser = bg.timelinesByUser || {};
    const myId = getMyUserId();
    // 계정을 모르고 잡은 것('*')을 우선 깔고, 지금 로그인된 계정 것으로 덮어쓴다.
    // 다른 계정에서 잡은 항목은 섞이지 않는다.
    const timelines = { ...(byUser['*'] || {}), ...((myId && byUser[myId]) || {}) };
    return {
      authorization: local.authorization || bg.authorization || null,
      csrf: getCookie('ct0') || local.csrf || bg.csrf || null,
      clientUuid: local.clientUuid || bg.clientUuid || null,
      platform: bg.platform || null,
      timelines,
      queryIds: { ...(bg.queryIds || {}), ...local.queryIds },
      tids: { ...(bg.tids || {}), ...local.tids },
      lastTid: local.lastTid || bg.lastTid || null
    };
  }

  function readiness(session) {
    const kinds = Object.keys(session.timelines || {});
    return {
      authorization: Boolean(session.authorization),
      csrf: Boolean(session.csrf),
      loggedIn: Boolean(getMyUserId()),
      screenName: getMyScreenName(),
      hasTweetsTab: kinds.includes('tweets'),
      hasRepliesTab: kinds.includes('replies'),
      hasRepostsTab: kinds.includes('reposts'),
      hasMediaVideoTab: kinds.includes('media'),
      hasMediaPhotoTab: kinds.includes('mediaPhoto'),
      timelines: kinds.map((kind) => ({
        kind,
        label: timelineLabel(kind, session.timelines[kind])
      }))
    };
  }

  function buildAcceptLanguage() {
    const languages = navigator.languages;
    if (!languages || languages.length === 0) return 'en-US,en;q=0.9';
    let q = 1;
    return languages
      .map((lang) => {
        const out = q < 1 ? `${lang};q=${q.toFixed(1)}` : lang;
        q -= 0.1;
        return out;
      })
      .join(',');
  }

  function buildHeaders(session, operation) {
    const headers = {
      accept: '*/*',
      'accept-language': buildAcceptLanguage(),
      authorization: session.authorization,
      'content-type': 'application/json',
      'x-csrf-token': session.csrf,
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-client-language': (navigator.language || 'en').split('-')[0]
    };
    const tid = session.tids[operation] || session.lastTid;
    if (tid) headers['x-client-transaction-id'] = tid;
    if (session.clientUuid) headers['x-client-uuid'] = session.clientUuid;
    return headers;
  }

  // ------------------------------------------------------- 타임라인 조회

  /**
   * 브라우저가 실제로 보낸 요청 URL 을 재사용하고 variables 만 갈아끼운다.
   * (features / fieldToggles 는 X 가 수시로 바꾸므로 그대로 쓰는 게 가장 안전)
   */
  function buildTimelineUrl(sampleUrl, userId, cursor, count) {
    const url = new URL(sampleUrl, location.origin);
    let variables = {};
    try {
      variables = JSON.parse(url.searchParams.get('variables') || '{}');
    } catch (e) {
      variables = {};
    }
    variables.userId = String(userId);
    variables.count = count;
    if (cursor) variables.cursor = cursor;
    else delete variables.cursor;
    if (variables.includePromotedContent === undefined) variables.includePromotedContent = false;
    url.searchParams.set('variables', JSON.stringify(variables));
    url.searchParams.set('__rc', '1'); // 우리가 보낸 요청 표시 (재캡처 방지)
    return url.toString();
  }

  async function fetchTimeline(ctx, kind, cursor, count) {
    const entry = ctx.session.timelines[kind];
    const url = buildTimelineUrl(entry.url, ctx.userId, cursor, count);
    const res = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(ctx.session, entry.op),
      referrer: ctx.referrer,
      referrerPolicy: 'strict-origin-when-cross-origin',
      mode: 'cors',
      credentials: 'include'
    });

    if (res.status === 429) return { rateLimited: true };
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { error: `HTTP ${res.status} ${body.slice(0, 200)}` };
    }

    const data = await res.json();
    if ((!data || !data.data) && data && data.errors && data.errors.length) {
      return { error: data.errors.map((e) => e.message).join(', ') };
    }

    const user = data?.data?.user?.result;
    const instructions =
      user?.timeline?.timeline?.instructions ||
      user?.timeline_v2?.timeline?.instructions ||
      user?.timeline?.instructions ||
      [];

    return { instructions };
  }

  // --------------------------------------------------------- 트윗 파싱

  function unwrap(result) {
    if (!result) return null;
    if (result.__typename === 'TweetWithVisibilityResults' && result.tweet) return result.tweet;
    if (result.__typename === 'TweetTombstone') return null;
    return result;
  }

  function tweetFromItemContent(itemContent) {
    if (!itemContent || itemContent.itemType !== 'TimelineTweet') return null;
    return unwrap(itemContent.tweet_results?.result);
  }

  function parseInstructions(instructions) {
    let entries = [];
    let pinnedId = null;

    for (const ins of instructions) {
      if (ins.type === 'TimelineAddEntries' && Array.isArray(ins.entries)) {
        entries = entries.concat(ins.entries);
      } else if (ins.type === 'TimelinePinEntry' && ins.entry) {
        const t = tweetFromItemContent(ins.entry.content?.itemContent);
        if (t) pinnedId = t.rest_id || t.legacy?.id_str || null;
      }
    }

    const tweets = [];
    let cursor = null;

    for (const entry of entries) {
      const entryId = entry.entryId || '';
      const content = entry.content || {};

      if (content.entryType === 'TimelineTimelineCursor' || entryId.startsWith('cursor-')) {
        if (content.cursorType === 'Bottom' || entryId.startsWith('cursor-bottom')) {
          cursor = content.value;
        }
        continue;
      }

      if (content.entryType === 'TimelineTimelineItem') {
        const t = tweetFromItemContent(content.itemContent);
        if (t) tweets.push({ tweet: t, entryId });
        continue;
      }

      if (content.entryType === 'TimelineTimelineModule' && Array.isArray(content.items)) {
        // profile-conversation-* : 대화(타래) 묶음
        for (const it of content.items) {
          const t = tweetFromItemContent(it.item?.itemContent);
          if (t) tweets.push({ tweet: t, entryId });
        }
      }
    }

    return { tweets, cursor, pinnedId };
  }

  function fullText(tweet) {
    const parts = [];
    if (tweet.legacy?.full_text) parts.push(tweet.legacy.full_text);
    const note = tweet.note_tweet?.note_tweet_results?.result?.text;
    if (note) parts.push(note);
    return parts.join('\n');
  }

  function mediaList(tweet) {
    return tweet.legacy?.extended_entities?.media || tweet.legacy?.entities?.media || [];
  }

  function preview(tweet) {
    const text = fullText(tweet).replace(/\s+/g, ' ').trim();
    return text.length > 40 ? text.slice(0, 40) + '…' : text || '(본문 없음)';
  }

  /**
   * entities.user_mentions 는 X 가 "정식 멘션"으로 인식한 것만 담는다.
   * 앞에 공백 없이 붙이는 등 애매하게 적으면 엔티티가 안 잡혀도 화면엔 "@아이디"가
   * 그대로 보인다. "멘션만 삭제"가 이런 경우를 놓치지 않도록 본문 텍스트에서도
   * "@핸들" 패턴을 직접 찾는다(내 계정 자신을 부른 경우는 제외).
   */
  const MENTION_RE = /@(\w{1,15})/g;
  function textMentionsOther(text, myScreenName) {
    if (!text) return false;
    const mine = (myScreenName || '').toLowerCase();
    let m;
    MENTION_RE.lastIndex = 0;
    while ((m = MENTION_RE.exec(text))) {
      if (m[1].toLowerCase() !== mine) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ 필터

  function classify(node, cfg, ctx, pass) {
    const tweet = node.tweet;
    const legacy = tweet.legacy || {};
    const id = tweet.rest_id || legacy.id_str;
    if (!id) return { action: 'skip', reason: 'id 없음', id: null, kind: '?', silent: true };

    // 대화 묶음에는 남의 트윗이 섞인다.
    const ownerId = legacy.user_id_str || tweet.core?.user_results?.result?.rest_id;
    if (ownerId !== ctx.userId) {
      return { action: 'skip', reason: '내 트윗 아님', id, kind: 'other', silent: true };
    }

    const isRetweet = Boolean(legacy.retweeted_status_result);
    // kind(게시물/답글 체크박스 대상 구분)는 진짜 답글 필드만 본다. "@아이디"로
    // 시작하는 글도 X 의 게시물(전체) 탭에서 수집되는 평범한 게시물이라 여기 넣는다.
    const isReply = Boolean(legacy.in_reply_to_status_id_str);
    const kind = isRetweet ? 'retweet' : isReply ? 'reply' : 'tweet';

    // "멘션만 삭제"/"타래 유지" 판정용. kind 와는 별개다.
    // "@아이디"로 시작하는 글은 진짜 답글이 아니어도 멘션류로 취급해서 이 두
    // 옵션의 대상이 되게 한다. 문장 중간에 낀 멘션은 여기 해당 안 된다(평범한
    // 게시물로 그대로 둔다).
    const leadingMentionMatch = !isRetweet ? fullText(tweet).trim().match(/^@(\w{1,15})/) : null;
    const leadingMentionHandle = leadingMentionMatch ? leadingMentionMatch[1] : null;
    const mentionLike = isReply || Boolean(leadingMentionHandle);
    const repliesToSelf =
      (isReply && legacy.in_reply_to_user_id_str === ctx.userId) ||
      (leadingMentionHandle &&
        ctx.myScreenName &&
        leadingMentionHandle.toLowerCase() === ctx.myScreenName.toLowerCase());

    // ---- 1. 삭제 대상 종류
    // 미디어 탭은 종류(게시물/답글/리트윗)와 무관하게 그 탭에 나온 건 전부 대상으로 본다.
    if (pass !== 'media' && pass !== 'mediaPhoto') {
      if (kind === 'retweet' && !cfg.targets.retweets) {
        return { action: 'skip', reason: '대상 아님(리트윗)', id, kind, silent: true };
      }
      if (kind === 'reply' && !cfg.targets.replies) {
        return { action: 'skip', reason: '대상 아님(답글)', id, kind, silent: true };
      }
      if (kind === 'tweet' && !cfg.targets.tweets) {
        return { action: 'skip', reason: '대상 아님(퍼블트)', id, kind, silent: true };
      }
    }

    // ---- 2. 지정 트윗 제외
    const inner = isRetweet ? unwrap(legacy.retweeted_status_result.result) : null;
    const innerId = inner ? inner.rest_id || inner.legacy?.id_str : null;
    if (cfg.excludeIds.includes(id) || (innerId && cfg.excludeIds.includes(innerId))) {
      return { action: 'skip', reason: '지정 트윗 제외', id, kind, tweet };
    }

    // ---- 3. 고정(메인) 트윗
    if (cfg.keepPinned && ctx.pinnedIds.has(id)) {
      return { action: 'skip', reason: '고정 트윗 제외', id, kind, tweet };
    }

    // 지표·본문 판정 기준 (리트윗은 원본 기준)
    const subject = inner || tweet;
    const subjectLegacy = subject.legacy || {};

    // ---- 4. 미디어 탭 세부 종류 (영상/사진)
    // X 의 /media 탭(필터 없음)은 영상뿐 아니라 사진도 같이 섞여 나온다. 탭(패스) 선택만으로는
    // 종류를 가를 수 없으므로, 실제 첨부 미디어 타입을 봐서 영상 탭엔 영상/움짤만, 사진 탭엔
    // 사진만 남긴다.
    if (pass === 'media' || pass === 'mediaPhoto') {
      const media = mediaList(subject);
      const hasVideo = media.some((m) => m.type === 'video' || m.type === 'animated_gif');
      if (pass === 'media' && !hasVideo) {
        return { action: 'skip', reason: '대상 아님(사진 - 미디어-영상 탭 전용)', id, kind, silent: true };
      }
      if (pass === 'mediaPhoto' && hasVideo) {
        return { action: 'skip', reason: '대상 아님(영상 - 미디어-사진 탭 전용)', id, kind, silent: true };
      }
    }

    // ---- 5. 답글 세분화 (리트윗 제외)
    if (kind !== 'retweet') {
      if (cfg.keepThreads && mentionLike && repliesToSelf) {
        return { action: 'skip', reason: '내 타래 유지', id, kind, tweet };
      }
      // 멘션만 삭제는 "멘션류"(진짜 답글 + @아이디로 시작하는 글)에만 적용한다.
      // 문장 중간에 멘션이 섞인 일반 게시글은 이 옵션과 무관하게 게시물 체크로만 처리한다.
      if (cfg.mentionsOnly && mentionLike) {
        const mentions = legacy.entities?.user_mentions || [];
        const hasOtherEntity = mentions.some((m) => m.id_str && m.id_str !== ctx.userId);
        const hasOtherInText = hasOtherEntity || textMentionsOther(fullText(subject), ctx.myScreenName);
        if (!hasOtherInText) {
          return { action: 'skip', reason: '타 계정 멘션 없음', id, kind, tweet };
        }
      }
    }

    // ---- 6. 제외 조건
    if (cfg.keepMedia && mediaList(subject).length > 0) {
      return { action: 'skip', reason: '미디어 첨부 제외', id, kind, tweet };
    }
    if (cfg.keepFavorited && subjectLegacy.favorited === true) {
      return { action: 'skip', reason: '내가 좋아요함', id, kind, tweet };
    }
    if (cfg.minLikes !== null && (subjectLegacy.favorite_count || 0) >= cfg.minLikes) {
      return { action: 'skip', reason: `좋아요 ${subjectLegacy.favorite_count}`, id, kind, tweet };
    }
    if (cfg.minRetweets !== null && (subjectLegacy.retweet_count || 0) >= cfg.minRetweets) {
      return { action: 'skip', reason: `RT ${subjectLegacy.retweet_count}`, id, kind, tweet };
    }
    if (cfg.excludeKeywords.length > 0) {
      const text = fullText(subject).toLowerCase();
      const hit = cfg.excludeKeywords.find((w) => text.includes(w));
      if (hit) return { action: 'skip', reason: `키워드 제외(${hit})`, id, kind, tweet };
    }

    // ---- 7. 기간
    if (cfg.afterDate || cfg.beforeDate) {
      const created = legacy.created_at ? new Date(legacy.created_at).getTime() : null;
      if (created !== null) {
        if (cfg.afterDate && created < cfg.afterDate) {
          return { action: 'skip', reason: '기간 이전', id, kind, tweet };
        }
        if (cfg.beforeDate && created > cfg.beforeDate) {
          return { action: 'skip', reason: '기간 이후', id, kind, tweet };
        }
      }
    }

    if (kind === 'retweet') {
      return { action: 'unretweet', reason: '', id, kind, sourceId: innerId || id, tweet };
    }
    return { action: 'delete', reason: '', id, kind, tweet };
  }

  // ------------------------------------------------------------ 삭제

  async function callGraphql(ctx, operation, variables) {
    const queryId = ctx.session.queryIds[operation];
    if (!queryId) throw new Error(`${operation} queryId 를 모릅니다.`);
    // 변형(mutation) 요청에는 군더더기 파라미터를 붙이지 않는다.
    const url = `${location.origin}/i/api/graphql/${queryId}/${operation}`;
    return fetch(url, {
      method: 'POST',
      headers: buildHeaders(ctx.session, operation),
      referrer: ctx.referrer,
      referrerPolicy: 'strict-origin-when-cross-origin',
      mode: 'cors',
      credentials: 'include',
      body: JSON.stringify({ variables, queryId })
    });
  }

  async function removeOne(ctx, decision) {
    // 현재 X 웹앱과 정확히 같은 형태로 보낸다.
    //  - RT 취소는 UnretweetTweet 이 아니라 DeleteRetweet
    //  - 예전에 쓰던 dark_request 변수는 스키마에서 사라졌다. 넣으면 422 가 난다.
    const operation = decision.action === 'unretweet' ? 'DeleteRetweet' : 'DeleteTweet';
    const variables =
      decision.action === 'unretweet'
        ? { source_tweet_id: decision.sourceId }
        : { tweet_id: decision.id };

    const res = await callGraphql(ctx, operation, variables);
    if (res.status === 429) return { rateLimited: true };
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // queryId 가 낡으면 422 GRAPHQL_VALIDATION_FAILED 가 온다. 번들에서 다시 찾는다.
      if (res.status === 422 || /GRAPHQL_VALIDATION_FAILED/.test(body)) {
        return { staleQueryId: true, operation, error: `HTTP ${res.status} ${body.slice(0, 120)}` };
      }
      return { error: `HTTP ${res.status} ${body.slice(0, 160)}` };
    }
    const data = await res.json().catch(() => ({}));
    if (data.errors && data.errors.length) {
      const msg = data.errors.map((e) => e.message).join(', ');
      if (/not found|No status found|already|does not exist/i.test(msg)) {
        return { ok: true, alreadyGone: true };
      }
      return { error: msg };
    }
    return { ok: true };
  }

  // ------------------------------------------------------- 배치 스로틀

  async function maybeCooldown(cfg) {
    if (cfg.dryRun) return;
    if (state.batchCount < cfg.batchSize) return;

    const waitMs = Math.round(cfg.cooldownMinutes * 60 * 1000);

    state.cooldownUntil = Date.now() + waitMs;
    setPhase('cooldown', `${cfg.batchSize}개 처리 · ${cfg.cooldownMinutes}분 대기`);
    log(
      `배치 ${cfg.batchSize}개 완료. 스팸 방지를 위해 ${cfg.cooldownMinutes}분 대기합니다.`,
      'cooldown'
    );

    await interruptibleSleep(waitMs);

    state.cooldownUntil = 0;
    state.batchCount = 0;
    if (!state.stopRequested) log('대기 종료. 계속합니다.', 'cooldown');
  }

  async function handleRateLimit(cfg) {
    const waitMs = cfg.rateLimitMinutes * 60 * 1000;
    state.cooldownUntil = Date.now() + waitMs;
    setPhase('ratelimited', `요청 제한(429) · ${cfg.rateLimitMinutes}분 대기`);
    log(`요청 제한에 걸렸습니다. ${cfg.rateLimitMinutes}분 대기합니다.`, 'error');
    await interruptibleSleep(waitMs);
    state.cooldownUntil = 0;
    if (!state.stopRequested) log('대기 종료. 재시도합니다.', 'info');
  }

  // ------------------------------------------------------------ 설정

  function normalizeConfig(raw) {
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const parseIds = (text) =>
      String(text || '')
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const m = s.match(/status\/(\d+)/);
          return m ? m[1] : s.replace(/\D/g, '');
        })
        .filter(Boolean);

    return {
      targets: {
        tweets: Boolean(raw.targets?.tweets),
        replies: Boolean(raw.targets?.replies),
        retweets: Boolean(raw.targets?.retweets),
        mediaVideo: Boolean(raw.targets?.mediaVideo),
        mediaPhoto: Boolean(raw.targets?.mediaPhoto)
      },
      mentionsOnly: Boolean(raw.mentionsOnly),
      keepThreads: Boolean(raw.keepThreads),
      keepPinned: Boolean(raw.keepPinned),
      keepMedia: Boolean(raw.keepMedia),
      keepFavorited: Boolean(raw.keepFavorited),
      minLikes: raw.useMinLikes ? num(raw.minLikes) : null,
      minRetweets: raw.useMinRetweets ? num(raw.minRetweets) : null,
      excludeKeywords: String(raw.excludeKeywords || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      excludeIds: parseIds(raw.excludeIds),
      afterDate: raw.afterDate ? new Date(raw.afterDate + 'T00:00:00').getTime() : null,
      beforeDate: raw.beforeDate ? new Date(raw.beforeDate + 'T23:59:59').getTime() : null,
      // 한 번에 몇 개씩 읽어올지. 너무 크면 X 가 거부하거나 잘라서 줄 수 있어 100 으로 막는다.
      pageSize: Math.min(100, Math.max(5, num(raw.pageSize) || 40)),
      batchSize: num(raw.batchSize) || 300,
      // 예전 설정(범위 두 칸)이 저장돼 있으면 큰 쪽을 이어받는다.
      cooldownMinutes:
        Number(raw.cooldownMinutes) || Number(raw.cooldownMaxMinutes) || 5,
      // 요청 제한(429) 전용 대기 시간은 팝업에 별도 입력이 없다.
      // 일반 휴식 시간(cooldownMinutes)과 같은 값을 쓴다.
      rateLimitMinutes:
        Number(raw.rateLimitMinutes) ||
        Number(raw.cooldownMinutes) ||
        Number(raw.cooldownMaxMinutes) ||
        5,
      deleteDelayMs: Number(raw.deleteDelayMs) || 700,
      maxDeletions: num(raw.maxDeletions),
      dryRun: Boolean(raw.dryRun)
    };
  }

  /**
   * 어떤 타임라인을 순회할지 결정.
   * 프로필의 "게시물 탭", "답글 탭(/with_replies)", "재게시 탭(/reposts)" 은
   * 서로 별개 타임라인이라 각각 따로 완주해야 한다. (X 가 재게시를 게시물 탭에서
   * 분리해 별도 탭으로 뺐다 — 게시물 탭엔 더 이상 리트윗이 안 섞여 나온다.)
   */
  function choosePasses(cfg, session) {
    const have = session.timelines || {};
    const passes = [];
    const missing = [];

    if (cfg.targets.tweets) {
      if (have.tweets) passes.push('tweets');
      else missing.push('게시물 탭');
    }
    if (cfg.targets.replies) {
      if (have.replies) passes.push('replies');
      else missing.push('답글 탭(/with_replies)');
    }
    if (cfg.targets.retweets) {
      if (have.reposts) passes.push('reposts');
      else missing.push('재게시 탭(/reposts)');
    }
    if (cfg.targets.mediaVideo) {
      if (have.media) passes.push('media');
      else missing.push('미디어-영상 탭(/media)');
    }
    if (cfg.targets.mediaPhoto) {
      if (have.mediaPhoto) passes.push('mediaPhoto');
      else missing.push('미디어-사진 탭(/media?filter=photo)');
    }

    // 필요한 쪽을 하나도 못 잡았으면 잡힌 것으로라도 돈다.
    const all = Object.keys(have);
    if (passes.length === 0 && all.length > 0) passes.push(all[0]);

    return { passes, missing };
  }

  // ------------------------------------------------------------ 메인

  /** @param {'tweets'|'replies'} op 순회할 타임라인 종류 */
  async function runPass(op, cfg, ctx, seen) {
    let cursor = null;
    let emptyPages = 0;
    state.pass = ctx.label(op);
    log(`[${ctx.label(op)}] 순회 시작`, 'start');

    while (!state.stopRequested) {
      setPhase('scanning', `${ctx.label(op)} 읽는 중…`);

      const page = await fetchTimeline(ctx, op, cursor, cfg.pageSize);

      if (page.rateLimited) {
        await handleRateLimit(cfg);
        continue;
      }
      if (page.error) throw new Error(`${ctx.label(op)} 조회 실패: ${page.error}`);

      const { tweets, cursor: nextCursor, pinnedId } = parseInstructions(page.instructions);
      if (pinnedId) ctx.pinnedIds.add(pinnedId);

      const fresh = tweets.filter((n) => {
        const id = n.tweet.rest_id || n.tweet.legacy?.id_str;
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });

      state.scanned += fresh.length;

      const decisions = [];
      for (const node of fresh) {
        const d = classify(node, cfg, ctx, op);
        if (d.action === 'skip') {
          if (!d.silent) {
            state.skipped += 1;
            log(`보존 — ${d.reason} · ${preview(d.tweet)}`, 'skip');
          }
        } else {
          decisions.push(d);
        }
      }
      state.matched += decisions.length;

      if (fresh.length === 0) {
        emptyPages += 1;
        if (emptyPages >= 3) {
          log(`[${ctx.label(op)}] 새 트윗 없음. 종료합니다.`, 'info');
          return;
        }
      } else {
        emptyPages = 0;
      }

      for (const d of decisions) {
        if (state.stopRequested) return;

        if (cfg.maxDeletions && state.deleted >= cfg.maxDeletions) {
          log(`최대 삭제 개수(${cfg.maxDeletions})에 도달했습니다.`, 'info');
          state.stopRequested = true;
          return;
        }

        const verb = d.kind === 'retweet' ? 'RT 취소' : '삭제';
        setPhase('deleting', `${verb} 중…`);

        if (cfg.dryRun) {
          state.deleted += 1;
          log(`[미리보기] ${verb} 대상 · ${preview(d.tweet)}`, 'delete');
        } else {
          let attempt = 0;
          let done = false;
          while (attempt < 5 && !done && !state.stopRequested) {
            const r = await removeOne(ctx, d);
            if (r.rateLimited) {
              await handleRateLimit(cfg);
              continue;
            }
            if (r.staleQueryId) {
              // queryId 가 낡았다. X 번들에서 다시 찾아 갱신하고 재시도한다.
              const before = ctx.session.queryIds[r.operation];
              const scan = await refreshQueryIds();
              const after = scan && scan.queryIds && scan.queryIds[r.operation];
              if (after && after !== before) {
                ctx.session.queryIds = { ...ctx.session.queryIds, ...scan.queryIds };
                log(`${r.operation} queryId 를 갱신했습니다 (${before} → ${after}).`, 'info');
                continue; // 재시도 (attempt 소모 없음)
              }
              attempt += 1;
              if (attempt >= 5) {
                state.failed += 1;
                log(
                  `실패 · ${d.id} — ${r.operation} queryId 를 찾지 못했습니다. ` +
                    `X 웹에서 트윗 하나를 직접 ${verb} 해보면 자동으로 학습합니다.`,
                  'error'
                );
              } else {
                await interruptibleSleep(2000);
              }
              continue;
            }
            if (r.ok) {
              state.deleted += 1;
              state.batchCount += 1;
              log(`${verb} · ${preview(d.tweet)}${r.alreadyGone ? ' (이미 없음)' : ''}`, 'delete');
              done = true;
            } else {
              attempt += 1;
              if (attempt >= 5) {
                state.failed += 1;
                log(`실패 · ${d.id} — ${r.error}`, 'error');
              } else {
                await interruptibleSleep(3000 * attempt);
              }
            }
          }
          await interruptibleSleep(cfg.deleteDelayMs);
        }

        await maybeCooldown(cfg);
      }

      if (!nextCursor || nextCursor === cursor) {
        log(`[${ctx.label(op)}] 마지막 페이지까지 확인했습니다.`, 'info');
        return;
      }
      cursor = nextCursor;
      await interruptibleSleep(1200);
    }
  }

  async function run(rawConfig) {
    const cfg = normalizeConfig(rawConfig);

    if (
      !cfg.targets.tweets &&
      !cfg.targets.replies &&
      !cfg.targets.retweets &&
      !cfg.targets.mediaVideo &&
      !cfg.targets.mediaPhoto
    ) {
      throw new Error('삭제 대상을 최소 하나 선택하세요.');
    }

    const session = await buildSession();
    const ready = readiness(session);

    if (!ready.loggedIn) throw new Error('로그인 정보를 찾을 수 없습니다. x.com 에 로그인했는지 확인하세요.');
    if (!ready.csrf) throw new Error('CSRF 토큰(ct0)을 찾을 수 없습니다.');
    if (!ready.authorization) {
      throw new Error('세션 정보를 아직 못 잡았습니다. 프로필 트윗/답글 탭을 열고 새로고침하세요.');
    }
    if (ready.timelines.length === 0) {
      throw new Error(
        '타임라인 요청을 아직 못 잡았습니다. 프로필 → 게시물 탭, 답글 탭, 재게시 탭(필요하면 미디어-영상/미디어-사진 탭도)을 각각 한 번씩 열어주세요.'
      );
    }

    const { passes, missing } = choosePasses(cfg, session);

    const ctx = {
      userId: getMyUserId(),
      myScreenName: ready.screenName || null,
      session,
      referrer: ready.screenName
        ? `https://x.com/${ready.screenName}/with_replies`
        : `${location.origin}/home`,
      pinnedIds: new Set(),
      label: (kind) => timelineLabel(kind, session.timelines[kind])
    };

    Object.assign(state, {
      running: true,
      stopRequested: false,
      pass: null,
      scanned: 0,
      matched: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
      batchCount: 0,
      cooldownUntil: 0,
      dryRun: cfg.dryRun,
      startedAt: Date.now(),
      finishedAt: 0
    });
    state.log.length = 0;
    logSeq = 0;
    showOverlay();

    const targetNames = [
      cfg.targets.tweets && '퍼블트',
      cfg.targets.replies && '답글',
      cfg.targets.retweets && '리트윗',
      cfg.targets.mediaVideo && '미디어-영상',
      cfg.targets.mediaPhoto && '미디어-사진'
    ].filter(Boolean);

    log(`정리 시작 — 대상: ${targetNames.join(', ')}${cfg.dryRun ? ' (미리보기)' : ''}`, 'start');
    log(`순회할 타임라인: ${passes.map((p) => ctx.label(p)).join(' → ')}`, 'info');
    for (const name of missing) {
      log(`주의: ${name} 타임라인을 못 잡았습니다. 그 탭을 한 번 열고 다시 실행하세요.`, 'error');
    }
    if (!cfg.dryRun) {
      log(`배치 ${cfg.batchSize}개마다 ${cfg.cooldownMinutes}분 대기`, 'info');

      // queryId 는 X 가 배포할 때마다 바뀐다. 시작 전에 번들에서 최신 값을 확보한다.
      setPhase('scanning', 'queryId 확인 중…');
      const scan = await refreshQueryIds();
      if (scan && scan.queryIds) {
        ctx.session.queryIds = { ...ctx.session.queryIds, ...scan.queryIds };
        log(
          `queryId 확인 — DeleteTweet: ${ctx.session.queryIds.DeleteTweet || '?'}, ` +
            `DeleteRetweet: ${ctx.session.queryIds.DeleteRetweet || '?'}`,
          'info'
        );
      } else {
        log('X 번들에서 queryId 를 읽지 못했습니다. 알려진 값으로 진행합니다.', 'info');
      }
    }

    const seen = new Set();

    try {
      for (const op of passes) {
        if (state.stopRequested) break;
        await runPass(op, cfg, ctx, seen);
      }

      state.pass = null;
      setPhase('done', state.stopRequested ? '사용자 중지' : '완료');
      log(
        `종료 — 검사 ${state.scanned} · 처리 ${state.deleted} · 보존 ${state.skipped} · 실패 ${state.failed}`,
        'start'
      );
    } catch (err) {
      setPhase('error', err.message);
      log(err.message, 'error');
      throw err;
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
      hideOverlay();
    }
  }

  // --------------------------------------------------------- 메시지 API

  /**
   * 팝업은 0.7~2초마다 상태를 물어본다. 매번 로그 전체를 직렬화해 넘기면 낭비라
   * 팝업이 이미 받은 개수(from) 이후만 보낸다.
   */
  function snapshot(from) {
    const total = logSeq;
    const have = Number.isFinite(from) ? Math.max(0, from) : 0;
    // 잘려나간 만큼을 감안해 실제로 남아 있는 것 중에서만 자른다.
    const firstSeq = logSeq - state.log.length;
    const startIndex = Math.max(0, have - firstSeq);
    const reset = have < firstSeq; // 팝업이 놓친 구간이 이미 잘려나감

    return {
      running: state.running,
      phase: state.phase,
      pass: state.pass,
      message: state.message,
      scanned: state.scanned,
      matched: state.matched,
      deleted: state.deleted,
      skipped: state.skipped,
      failed: state.failed,
      batchCount: state.batchCount,
      cooldownUntil: state.cooldownUntil,
      dryRun: state.dryRun,
      logTotal: total,
      logReset: reset,
      log: reset ? state.log.slice() : state.log.slice(startIndex)
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return false;

    if (message.type === 'rc-status') {
      sendResponse({ ok: true, state: snapshot(message.logFrom) });
      return false;
    }

    if (message.type === 'rc-ready') {
      buildSession().then((session) => {
        sendResponse({ ok: true, ready: readiness(session) });
      });
      return true;
    }

    if (message.type === 'rc-stop') {
      state.stopRequested = true;
      if (state.running) log('중지 요청됨…', 'info');
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'rc-start') {
      if (state.running || state.starting) {
        sendResponse({ ok: false, error: '이미 실행 중입니다.' });
        return false;
      }
      state.starting = true;
      run(message.config)
        .catch((err) => {
          if (state.phase !== 'error') {
            setPhase('error', err.message);
            log(err.message, 'error');
          }
        })
        .finally(() => {
          state.starting = false;
        });
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });
})();
