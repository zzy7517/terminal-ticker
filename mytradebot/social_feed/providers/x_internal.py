"""文件用途：只读 X/Twitter 内部 GraphQL 客户端。

说明：这是按 xcli 行为重写的最小实现，只支持读取 Following feed。
不包含发推、点赞、关注等写操作。
"""
from __future__ import annotations

import json
import logging
import math
import os
import random
import re
import sys
import time
import urllib.parse
from dataclasses import dataclass
from datetime import timezone
from email.utils import parsedate_to_datetime
from typing import Any, Callable

from curl_cffi import requests as cffi_requests

from ..types import SocialAuthor, SocialFeedItem, SocialMetrics

LOGGER = logging.getLogger(__name__)
SOURCE_NAME = "x_following"
TWITTER_OPENAPI_URL = (
    "https://raw.githubusercontent.com/fa0311/"
    "twitter-openapi/refs/heads/main/src/config/placeholder.json"
)
BEARER_TOKEN = (
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs"
    "%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
)
FALLBACK_QUERY_IDS = {
    "HomeLatestTimeline": "BKB7oi212Fi7kQtCBGE4zA",
}
FEATURES = {
    "responsive_web_graphql_exclude_directive_enabled": True,
    "verified_phone_label_enabled": False,
    "creator_subscriptions_tweet_preview_api_enabled": True,
    "responsive_web_graphql_timeline_navigation_enabled": True,
    "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
    "c9s_tweet_anatomy_moderator_badge_enabled": True,
    "tweetypie_unmention_optimization_enabled": True,
    "responsive_web_edit_tweet_api_enabled": True,
    "graphql_is_translatable_rweb_tweet_is_translatable_enabled": True,
    "view_counts_everywhere_api_enabled": True,
    "longform_notetweets_consumption_enabled": True,
    "responsive_web_twitter_article_tweet_consumption_enabled": True,
    "tweet_awards_web_tipping_enabled": False,
    "longform_notetweets_rich_text_read_enabled": True,
    "longform_notetweets_inline_media_enabled": True,
    "rweb_video_timestamps_enabled": True,
    "responsive_web_media_download_video_enabled": True,
    "freedom_of_speech_not_reach_fetch_enabled": True,
    "standardized_nudges_misinfo": True,
    "responsive_web_enhance_cards_enabled": False,
}

_CHROME_VERSION = "133"
_QUERY_ID_CACHE: dict[str, str] = {}


class XInternalError(RuntimeError):
    """X 内部 API 调用错误。"""

    def __init__(self, message: str, *, status_code: int = 0) -> None:
        super().__init__(message)
        self.status_code = status_code


class XAuthenticationError(XInternalError):
    """X cookie 缺失或失效。"""


@dataclass(frozen=True)
class XCookieAuth:
    """说明：X 内部接口所需 cookie。"""

    auth_token: str
    ct0: str
    cookie_string: str | None = None


def load_x_cookie_auth_from_env() -> XCookieAuth:
    """从环境变量读取 X cookie。"""
    auth_token = os.environ.get("TWITTER_AUTH_TOKEN", "").strip()
    ct0 = os.environ.get("TWITTER_CT0", "").strip()
    cookie_string = os.environ.get("TWITTER_COOKIE_STRING", "").strip() or None
    if not auth_token or not ct0:
        raise XAuthenticationError(
            "missing TWITTER_AUTH_TOKEN/TWITTER_CT0; copy auth_token and ct0 cookies from x.com",
            status_code=401,
        )
    return XCookieAuth(auth_token=auth_token, ct0=ct0, cookie_string=cookie_string)


def _deep_get(data: Any, *keys: Any) -> Any:
    current = data
    for key in keys:
        if isinstance(key, int):
            if isinstance(current, list) and 0 <= key < len(current):
                current = current[key]
            else:
                return None
        elif isinstance(current, dict):
            current = current.get(key)
        else:
            return None
    return current


def _parse_int(value: Any, default: int = 0) -> int:
    try:
        text = str(value).replace(",", "").strip()
        return int(float(text)) if text else default
    except (TypeError, ValueError):
        return default


def _created_at_ms(value: str, fallback_ms: int) -> int:
    if not value:
        return fallback_ms
    try:
        parsed = parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp() * 1000)
    except (TypeError, ValueError, OverflowError):
        return fallback_ms


def _sync_chrome_version(impersonate_target: str) -> None:
    global _CHROME_VERSION
    match = re.search(r"(\d+)", impersonate_target)
    if match:
        _CHROME_VERSION = match.group(1)


def _best_chrome_target() -> str:
    try:
        from curl_cffi.requests import BrowserType

        available = {item.value for item in BrowserType}
    except Exception:
        available = set()
    for target in ("chrome136", "chrome133", "chrome133a", "chrome131", "chrome130"):
        if target in available:
            return target
    chrome_targets = sorted(
        [
            value
            for value in available
            if value.startswith("chrome") and value.replace("chrome", "").isdigit()
        ],
        key=lambda value: int(value.replace("chrome", "")),
        reverse=True,
    )
    return chrome_targets[0] if chrome_targets else "chrome131"


def _get_user_agent() -> str:
    if sys.platform == "darwin":
        platform = "Macintosh; Intel Mac OS X 10_15_7"
    elif sys.platform.startswith("win"):
        platform = "Windows NT 10.0; Win64; x64"
    else:
        platform = "X11; Linux x86_64"
    return (
        "Mozilla/5.0 (%s) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/%s.0.0.0 Safari/537.36"
    ) % (platform, _CHROME_VERSION)


def _get_accept_language() -> str:
    raw = os.environ.get("LC_ALL") or os.environ.get("LC_MESSAGES") or os.environ.get("LANG")
    tag = (raw or "en_US.UTF-8").split(".", 1)[0].replace("_", "-") or "en-US"
    language = tag.split("-", 1)[0] or "en"
    return f"{tag},{language};q=0.9,en;q=0.8"


def _get_client_language() -> str:
    return _get_accept_language().split(",", 1)[0].split("-", 1)[0] or "en"


def _get_sec_ch_ua() -> str:
    return (
        f'"Chromium";v="{_CHROME_VERSION}", '
        f'"Not(A:Brand";v="99", "Google Chrome";v="{_CHROME_VERSION}"'
    )


def _get_sec_ch_ua_platform() -> str:
    if sys.platform == "darwin":
        return '"macOS"'
    if sys.platform.startswith("win"):
        return '"Windows"'
    return '"Linux"'


def _build_graphql_url(
    query_id: str,
    operation_name: str,
    variables: dict[str, Any],
    features: dict[str, Any],
) -> str:
    compact_features = {key: value for key, value in features.items() if value is not False}
    return "https://x.com/i/api/graphql/%s/%s?variables=%s&features=%s" % (
        query_id,
        operation_name,
        urllib.parse.quote(json.dumps(variables, separators=(",", ":"))),
        urllib.parse.quote(json.dumps(compact_features, separators=(",", ":"))),
    )


def _extract_author(user_data: dict[str, Any]) -> SocialAuthor:
    legacy = user_data.get("legacy", {}) if isinstance(user_data.get("legacy"), dict) else {}
    core = user_data.get("core", {}) if isinstance(user_data.get("core"), dict) else {}
    avatar = user_data.get("avatar", {}) if isinstance(user_data.get("avatar"), dict) else {}
    return SocialAuthor(
        id=str(user_data.get("rest_id") or ""),
        name=str(core.get("name") or legacy.get("name") or user_data.get("name") or "Unknown"),
        handle=str(
            core.get("screen_name")
            or legacy.get("screen_name")
            or user_data.get("screen_name")
            or "unknown"
        ),
        profile_image_url=str(avatar.get("image_url") or legacy.get("profile_image_url_https") or ""),
        verified=bool(user_data.get("is_blue_verified") or legacy.get("verified", False)),
    )


def _unwrap_visibility(result: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    if result.get("__typename") == "TweetWithVisibilityResults" and isinstance(result.get("tweet"), dict):
        return result["tweet"], bool(result.get("tweetInterstitial"))
    return result, False


def _parse_tweet_result(
    result: dict[str, Any],
    *,
    fetched_at_ms: int,
    depth: int = 0,
) -> SocialFeedItem | None:
    if depth > 2:
        return None
    tweet_data, _is_subscriber_only = _unwrap_visibility(result)
    if tweet_data.get("__typename") == "TweetTombstone":
        return None
    legacy = tweet_data.get("legacy")
    core = tweet_data.get("core")
    if not isinstance(legacy, dict) or not isinstance(core, dict):
        return None

    user = _deep_get(core, "user_results", "result") or {}
    user_legacy = user.get("legacy", {}) if isinstance(user.get("legacy"), dict) else {}
    user_core = user.get("core", {}) if isinstance(user.get("core"), dict) else {}

    is_repost = bool(_deep_get(legacy, "retweeted_status_result", "result"))
    actual_data = tweet_data
    actual_legacy = legacy
    actual_user = user
    reposted_by: str | None = None
    if is_repost:
        reposted_by = str(user_core.get("screen_name") or user_legacy.get("screen_name") or "")
        repost_result = _deep_get(legacy, "retweeted_status_result", "result") or {}
        repost_result, _repost_subscriber_only = _unwrap_visibility(repost_result)
        repost_legacy = repost_result.get("legacy")
        repost_core = repost_result.get("core")
        if isinstance(repost_legacy, dict) and isinstance(repost_core, dict):
            actual_data = repost_result
            actual_legacy = repost_legacy
            actual_user = _deep_get(repost_core, "user_results", "result") or {}

    tweet_id = str(actual_data.get("rest_id") or "")
    author = _extract_author(actual_user if isinstance(actual_user, dict) else {})
    note_text = _deep_get(actual_data, "note_tweet", "note_tweet_results", "result", "text")
    text = str(note_text or actual_legacy.get("full_text") or "")
    urls = tuple(
        str(item.get("expanded_url") or item.get("url") or "")
        for item in (_deep_get(actual_legacy, "entities", "urls") or [])
        if isinstance(item, dict) and (item.get("expanded_url") or item.get("url"))
    )
    quoted = _deep_get(actual_data, "quoted_status_result", "result")
    quoted_item = (
        _parse_tweet_result(quoted, fetched_at_ms=fetched_at_ms, depth=depth + 1)
        if isinstance(quoted, dict)
        else None
    )
    created_at = _created_at_ms(str(actual_legacy.get("created_at") or ""), fetched_at_ms)
    url = f"https://x.com/{author.handle}/status/{tweet_id}" if tweet_id and author.handle else ""
    return SocialFeedItem(
        source=SOURCE_NAME,
        external_id=tweet_id,
        url=url,
        author=author,
        text=text,
        created_at_ms=created_at,
        fetched_at_ms=fetched_at_ms,
        metrics=SocialMetrics(
            likes=_parse_int(actual_legacy.get("favorite_count")),
            reposts=_parse_int(actual_legacy.get("retweet_count")),
            replies=_parse_int(actual_legacy.get("reply_count")),
            quotes=_parse_int(actual_legacy.get("quote_count")),
            views=_parse_int(_deep_get(actual_data, "views", "count")),
            bookmarks=_parse_int(actual_legacy.get("bookmark_count")),
        ),
        urls=urls,
        lang=str(actual_legacy.get("lang") or ""),
        is_repost=is_repost,
        reposted_by=reposted_by or None,
        quoted_item=quoted_item,
        raw={"typename": actual_data.get("__typename", ""), "query": "HomeLatestTimeline"},
    )


def _parse_timeline_response(
    data: Any,
    get_instructions: Callable[[Any], Any],
    *,
    fetched_at_ms: int,
) -> tuple[list[SocialFeedItem], str | None]:
    tweets: list[SocialFeedItem] = []
    next_cursor: str | None = None
    instructions = get_instructions(data)
    if not isinstance(instructions, list):
        LOGGER.warning("x following feed: no timeline instructions found")
        return tweets, next_cursor

    for instruction in instructions:
        if not isinstance(instruction, dict):
            continue
        entries = instruction.get("entries") or instruction.get("moduleItems") or []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            content = entry.get("content", {})
            if not isinstance(content, dict):
                continue
            if content.get("cursorType") == "Bottom" and content.get("value"):
                next_cursor = str(content.get("value"))

            item_content = content.get("itemContent", {})
            result = _deep_get(item_content, "tweet_results", "result")
            if isinstance(result, dict):
                tweet = _parse_tweet_result(result, fetched_at_ms=fetched_at_ms)
                if tweet is not None:
                    tweets.append(tweet)

            for nested_item in content.get("items", []):
                nested_result = _deep_get(
                    nested_item,
                    "item",
                    "itemContent",
                    "tweet_results",
                    "result",
                )
                if isinstance(nested_result, dict):
                    tweet = _parse_tweet_result(nested_result, fetched_at_ms=fetched_at_ms)
                    if tweet is not None:
                        tweets.append(tweet)
    return tweets, next_cursor


class XInternalClient:
    """说明：使用 X 登录 cookie 读取 Following 信息流的最小客户端。"""

    def __init__(
        self,
        auth: XCookieAuth,
        *,
        request_delay_seconds: float = 2.5,
        max_retries: int = 2,
        retry_base_delay_seconds: float = 5.0,
        max_count: int = 200,
    ) -> None:
        self.auth = auth
        self.request_delay_seconds = max(0.0, float(request_delay_seconds))
        self.max_retries = max(0, int(max_retries))
        self.retry_base_delay_seconds = max(0.1, float(retry_base_delay_seconds))
        self.max_count = max(1, min(int(max_count), 500))
        target = _best_chrome_target()
        _sync_chrome_version(target)
        proxy = os.environ.get("TWITTER_PROXY", "").strip()
        self.session = cffi_requests.Session(
            impersonate=target,
            proxies={"https": proxy, "http": proxy} if proxy else None,
        )

    @classmethod
    def from_env(cls) -> "XInternalClient":
        return cls(load_x_cookie_auth_from_env())

    def fetch_following_feed(
        self,
        *,
        count: int = 20,
        cursor: str | None = None,
        include_promoted: bool = False,
        return_cursor: bool = False,
    ) -> list[SocialFeedItem] | tuple[list[SocialFeedItem], str | None]:
        """读取 X Following tab 的反向时间流。"""
        return self._fetch_timeline(
            "HomeLatestTimeline",
            count=max(1, int(count)),
            get_instructions=lambda data: _deep_get(
                data,
                "data",
                "home",
                "home_timeline_urt",
                "instructions",
            ),
            include_promoted=include_promoted,
            start_cursor=cursor,
            return_cursor=return_cursor,
        )

    def _fetch_timeline(
        self,
        operation_name: str,
        *,
        count: int,
        get_instructions: Callable[[Any], Any],
        include_promoted: bool = False,
        start_cursor: str | None = None,
        return_cursor: bool = False,
    ) -> list[SocialFeedItem] | tuple[list[SocialFeedItem], str | None]:
        count = min(count, self.max_count)
        tweets: list[SocialFeedItem] = []
        seen_ids: set[str] = set()
        cursor = start_cursor
        continuation_cursor: str | None = None
        max_attempts = int(math.ceil(count / 20.0)) + 2

        for attempt_index in range(max_attempts):
            variables: dict[str, Any] = {
                "count": min(count - len(tweets) + 5, 40),
                "includePromotedContent": include_promoted,
                "latestControlAvailable": True,
                "requestContext": "launch",
            }
            if cursor:
                variables["cursor"] = cursor
            fetched_at_ms = int(time.time() * 1000)
            data = self._graphql_get(operation_name, variables)
            new_tweets, next_cursor = _parse_timeline_response(
                data,
                get_instructions,
                fetched_at_ms=fetched_at_ms,
            )
            for tweet in new_tweets:
                if tweet.external_id and tweet.external_id not in seen_ids:
                    seen_ids.add(tweet.external_id)
                    tweets.append(tweet)
            if len(tweets) >= count or not next_cursor or next_cursor == cursor:
                continuation_cursor = next_cursor if next_cursor != cursor else None
                break
            continuation_cursor = next_cursor
            cursor = next_cursor
            if self.request_delay_seconds > 0 and attempt_index + 1 < max_attempts:
                time.sleep(self.request_delay_seconds * random.uniform(0.7, 1.5))

        sliced = tweets[:count]
        if return_cursor:
            return sliced, continuation_cursor
        return sliced

    def _graphql_get(self, operation_name: str, variables: dict[str, Any]) -> dict[str, Any]:
        query_id = self._resolve_query_id(operation_name, prefer_fallback=True)
        url = _build_graphql_url(query_id, operation_name, variables, FEATURES)
        try:
            return self._api_get(url)
        except XInternalError as exc:
            if exc.status_code in (404, 422):
                refreshed_query_id = self._resolve_query_id(operation_name, prefer_fallback=False)
                retry_url = _build_graphql_url(refreshed_query_id, operation_name, variables, FEATURES)
                return self._api_get(retry_url)
            raise

    def _resolve_query_id(self, operation_name: str, *, prefer_fallback: bool) -> str:
        if operation_name in _QUERY_ID_CACHE:
            return _QUERY_ID_CACHE[operation_name]
        fallback = FALLBACK_QUERY_IDS.get(operation_name)
        if prefer_fallback and fallback:
            _QUERY_ID_CACHE[operation_name] = fallback
            return fallback
        remote = self._fetch_remote_query_id(operation_name)
        if remote:
            _QUERY_ID_CACHE[operation_name] = remote
            return remote
        if fallback:
            _QUERY_ID_CACHE[operation_name] = fallback
            return fallback
        raise XInternalError(f"cannot resolve X queryId for {operation_name}")

    def _fetch_remote_query_id(self, operation_name: str) -> str | None:
        try:
            response = self.session.get(TWITTER_OPENAPI_URL, timeout=10)
            if response.status_code >= 400:
                return None
            payload = response.json()
        except Exception:
            return None
        operation = payload.get(operation_name, {}) if isinstance(payload, dict) else {}
        query_id = operation.get("queryId") if isinstance(operation, dict) else None
        return query_id if isinstance(query_id, str) and query_id else None

    def _api_get(self, url: str) -> dict[str, Any]:
        return self._api_request(url)

    def _api_request(self, url: str) -> dict[str, Any]:
        headers = self._build_headers()
        for attempt in range(self.max_retries + 1):
            try:
                response = self.session.get(url, headers=headers, timeout=30)
            except Exception as exc:
                raise XInternalError(f"X network error: {exc}") from exc
            if response.status_code == 429 and attempt < self.max_retries:
                wait_seconds = self.retry_base_delay_seconds * (2 ** attempt) + random.uniform(0, 2)
                LOGGER.warning("x following feed rate limited, retrying in %.1fs", wait_seconds)
                time.sleep(wait_seconds)
                continue
            if response.status_code in (401, 403):
                raise XAuthenticationError(
                    "X cookie expired or invalid; refresh TWITTER_AUTH_TOKEN/TWITTER_CT0",
                    status_code=response.status_code,
                )
            if response.status_code >= 400:
                raise XInternalError(
                    "X API error %d: %s" % (response.status_code, response.text[:500]),
                    status_code=response.status_code,
                )
            try:
                parsed = response.json()
            except (TypeError, ValueError) as exc:
                raise XInternalError("X API returned invalid JSON") from exc
            if isinstance(parsed, dict) and parsed.get("errors"):
                first = parsed["errors"][0] if parsed["errors"] else {}
                code = _parse_int(first.get("code"), 0) if isinstance(first, dict) else 0
                message = str(first.get("message") if isinstance(first, dict) else "unknown error")
                if code == 88 and attempt < self.max_retries:
                    wait_seconds = self.retry_base_delay_seconds * (2 ** attempt) + random.uniform(0, 2)
                    LOGGER.warning("x following feed rate limited (code 88), retrying in %.1fs", wait_seconds)
                    time.sleep(wait_seconds)
                    continue
                raise XInternalError(f"X API returned errors: {message}", status_code=429 if code == 88 else 0)
            return parsed
        raise XInternalError("X API rate limited after retries", status_code=429)

    def _build_headers(self) -> dict[str, str]:
        cookie = self.auth.cookie_string or f"auth_token={self.auth.auth_token}; ct0={self.auth.ct0}"
        return {
            "Authorization": f"Bearer {BEARER_TOKEN}",
            "Cookie": cookie,
            "X-Csrf-Token": self.auth.ct0,
            "X-Twitter-Active-User": "yes",
            "X-Twitter-Auth-Type": "OAuth2Session",
            "X-Twitter-Client-Language": _get_client_language(),
            "User-Agent": _get_user_agent(),
            "Origin": "https://x.com",
            "Referer": "https://x.com/",
            "Accept": "*/*",
            "Accept-Language": _get_accept_language(),
            "sec-ch-ua": _get_sec_ch_ua(),
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": _get_sec_ch_ua_platform(),
            "sec-ch-ua-arch": '"arm"' if "arm" in os.uname().machine.lower() else '"x86"',
            "sec-ch-ua-bitness": '"64"',
            "sec-ch-ua-full-version": f'"{_CHROME_VERSION}.0.0.0"',
            "sec-ch-ua-full-version-list": (
                f'"Google Chrome";v="{_CHROME_VERSION}.0.0.0", '
                f'"Chromium";v="{_CHROME_VERSION}.0.0.0", "Not.A/Brand";v="99.0.0.0"'
            ),
            "sec-ch-ua-model": '""',
            "sec-ch-ua-platform-version": '"15.0.0"' if sys.platform == "darwin" else '""',
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
        }
