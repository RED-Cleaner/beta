/**
 * RED Cleaner - MAIN world 인젝터
 *
 * X 웹앱이 실제로 보내는 GraphQL 요청을 fetch / XHR 후킹으로 가로채
 * URL(queryId·features 포함)과 헤더(authorization, transaction-id)를 확보한다.
 *
 * 타임라인 요청인지는 오퍼레이션 "이름"으로 판단하지 않는다. X 가 탭마다,
 * 버전마다 이름을 바꾸기 때문에 목록으로 거르면 한쪽 탭을 통째로 놓친다.
 * 대신 응답에 유저 타임라인 구조(instructions)가 있는지를 보고 판별한다.
 */

(() => {
  if (window.__RED_CLEANER_INJECTED__) return;
  window.__RED_CLEANER_INJECTED__ = true;

  const WANTED_HEADERS = [
    'authorization',
    'x-csrf-token',
    'x-client-uuid',
    'x-client-transaction-id',
    'x-twitter-client-language',
    'x-twitter-active-user'
  ];

  function parseOp(url) {
    const m = String(url || '').match(/\/graphql\/([^/?]+)\/([^/?#]+)/);
    if (!m) return null;
    return { queryId: m[1], op: m[2] };
  }

  function headersToObject(h) {
    const out = {};
    if (!h) return out;
    try {
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        h.forEach((v, k) => {
          if (WANTED_HEADERS.includes(k.toLowerCase())) out[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) {
          if (WANTED_HEADERS.includes(String(k).toLowerCase())) out[String(k).toLowerCase()] = v;
        }
      } else if (typeof h === 'object') {
        for (const k of Object.keys(h)) {
          if (WANTED_HEADERS.includes(k.toLowerCase())) out[k.toLowerCase()] = h[k];
        }
      }
    } catch (e) {
      /* noop */
    }
    return out;
  }

  function report(url, info, headers, isTimeline) {
    try {
      window.postMessage(
        {
          __redCleaner: 'capture',
          url: String(url),
          op: info.op,
          queryId: info.queryId,
          path: location.pathname + location.search, // 어느 프로필 탭(필터 포함)에서 나온 요청인지
          isTimeline: Boolean(isTimeline),
          headers
        },
        window.location.origin
      );
    } catch (e) {
      /* noop */
    }
  }

  /** 유저 타임라인 요청일 "가능성"이 있는 URL 인가 (응답을 뜯어볼 값어치가 있는지) */
  function looksLikeTimeline(url) {
    const s = String(url || '');
    // 타임라인 조회는 variables 에 count 와 userId 를 싣는다.
    return /%22count%22/.test(s) || /"count"/.test(s);
  }

  /** 응답 JSON 에 유저 타임라인 구조가 있는가 */
  function hasUserTimeline(json) {
    const user = json && json.data && json.data.user && json.data.user.result;
    if (!user) return false;
    const t = user.timeline_v2 || user.timeline;
    if (!t) return false;
    const ins = (t.timeline && t.timeline.instructions) || t.instructions;
    return Array.isArray(ins);
  }

  function inspectText(text, url, info, headers) {
    try {
      const json = JSON.parse(text);
      if (hasUserTimeline(json)) report(url, info, headers, true);
    } catch (e) {
      /* noop */
    }
  }

  // ------------------------------------------------------------ fetch

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      let info = null;
      let url = null;
      let headers = {};
      let method = 'GET';

      try {
        const isRequest = typeof Request !== 'undefined' && input instanceof Request;
        url = isRequest ? input.url : input;
        info = parseOp(url);
        if (info) {
          method = (init && init.method) || (isRequest && input.method) || 'GET';
          headers = headersToObject(init && init.headers);
          if (Object.keys(headers).length === 0 && isRequest) {
            headers = headersToObject(input.headers);
          }
          report(url, info, headers, false);
        }
      } catch (e) {
        /* noop */
      }

      const promise = origFetch.apply(this, arguments);

      if (info && String(method).toUpperCase() === 'GET' && looksLikeTimeline(url)) {
        promise
          .then((res) => {
            try {
              res
                .clone()
                .text()
                .then((text) => inspectText(text, url, info, headers))
                .catch(() => {});
            } catch (e) {
              /* noop */
            }
            return res;
          })
          .catch(() => {});
      }

      return promise;
    };
  }

  // -------------------------------------------------------------- XHR

  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSetHeader = XHR.setRequestHeader;
  const origSend = XHR.send;

  XHR.open = function (method, url) {
    try {
      this.__rcUrl = url;
      this.__rcMethod = method;
      this.__rcHeaders = {};
    } catch (e) {
      /* noop */
    }
    return origOpen.apply(this, arguments);
  };

  XHR.setRequestHeader = function (name, value) {
    try {
      const key = String(name).toLowerCase();
      if (this.__rcHeaders && WANTED_HEADERS.includes(key)) this.__rcHeaders[key] = value;
    } catch (e) {
      /* noop */
    }
    return origSetHeader.apply(this, arguments);
  };

  XHR.send = function () {
    try {
      const info = parseOp(this.__rcUrl);
      if (info) {
        const url = this.__rcUrl;
        const headers = this.__rcHeaders || {};
        report(url, info, headers, false);

        if (String(this.__rcMethod || 'GET').toUpperCase() === 'GET' && looksLikeTimeline(url)) {
          this.addEventListener('load', () => {
            try {
              if (this.responseType === '' || this.responseType === 'text') {
                inspectText(this.responseText, url, info, headers);
              } else if (this.responseType === 'json' && this.response) {
                if (hasUserTimeline(this.response)) report(url, info, headers, true);
              }
            } catch (e) {
              /* noop */
            }
          });
        }
      }
    } catch (e) {
      /* noop */
    }
    return origSend.apply(this, arguments);
  };
})();
