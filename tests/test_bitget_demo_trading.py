"""Test Bitget demo trading client behavior."""
import json
import os
import unittest
from unittest.mock import patch

from tradex.trading.bitget_demo import (
    BitgetDemoTradingError,
    _signed_post,
    _sign,
    bitget_demo_credentials_available,
    open_demo_position,
)


class BitgetDemoTradingTests(unittest.TestCase):
    def test_sign_uses_bitget_hmac_payload(self) -> None:
        signature = _sign(
            timestamp_ms="16273667805456",
            method="POST",
            request_path="/api/v2/mix/order/place-order",
            body='{"symbol":"BTCUSDT"}',
            secret="secret",
        )
        self.assertEqual(signature, "KR/94jFzQBeG+j4VKJfg1K1Mf6f7Ae1xIVycDhclDu8=")

    def test_credentials_require_demo_env_names(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(bitget_demo_credentials_available())
        with patch.dict(
            os.environ,
            {
                "BITGET_DEMO_API_KEY": "k",
                "BITGET_DEMO_API_SECRET": "s",
                "BITGET_DEMO_PASSPHRASE": "p",
            },
            clear=True,
        ):
            self.assertTrue(bitget_demo_credentials_available())

    def test_signed_post_adds_paptrading_header(self) -> None:
        captured = {}

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps({
                    "code": "00000",
                    "data": {"orderId": "o-1", "clientOid": "c-1"},
                }).encode("utf-8")

        def fake_urlopen(request, timeout):
            captured["url"] = request.full_url
            captured["body"] = request.data.decode("utf-8")
            captured["headers"] = {
                key.lower(): value for key, value in request.header_items()
            }
            captured["timeout"] = timeout
            return FakeResponse()

        with patch.dict(
            os.environ,
            {
                "BITGET_DEMO_API_KEY": "key",
                "BITGET_DEMO_API_SECRET": "secret",
                "BITGET_DEMO_PASSPHRASE": "pass",
            },
            clear=True,
        ), patch("tradex.trading.bitget_demo.time.time", return_value=1.234), patch(
            "tradex.trading.bitget_demo.urlopen",
            side_effect=fake_urlopen,
        ):
            payload = _signed_post("/api/v2/mix/order/place-order", {"symbol": "BTCUSDT"})

        self.assertEqual(payload["code"], "00000")
        self.assertEqual(captured["url"], "https://api.bitget.com/api/v2/mix/order/place-order")
        self.assertEqual(captured["body"], '{"symbol":"BTCUSDT"}')
        self.assertEqual(captured["timeout"], 15)
        headers = captured["headers"]
        self.assertEqual(headers["access-key"], "key")
        self.assertEqual(headers["access-passphrase"], "pass")
        self.assertEqual(headers["access-timestamp"], "1234")
        self.assertEqual(headers["paptrading"], "1")
        self.assertEqual(
            headers["access-sign"],
            _sign(
                timestamp_ms="1234",
                method="POST",
                request_path="/api/v2/mix/order/place-order",
                body='{"symbol":"BTCUSDT"}',
                secret="secret",
            ),
        )

    def test_futures_limit_order_payload(self) -> None:
        captured = {}

        def fake_signed_post(path, body):
            captured["path"] = path
            captured["body"] = body
            return {"code": "00000", "data": {"orderId": "o-1", "clientOid": body["clientOid"]}}

        with patch("tradex.trading.bitget_demo._client_oid", return_value="cid-1"), patch(
            "tradex.trading.bitget_demo._signed_post",
            side_effect=fake_signed_post,
        ):
            result = open_demo_position(
                symbol="btcusdt",
                inst_type="USDT-FUTURES",
                is_buy=True,
                size=0.01,
                order_type="limit",
                limit_price=60000,
                margin_mode="isolated",
                margin_coin="usdt",
                force="ioc",
            )

        self.assertEqual(captured["path"], "/api/v2/mix/order/place-order")
        self.assertEqual(captured["body"], {
            "symbol": "BTCUSDT",
            "productType": "USDT-FUTURES",
            "marginMode": "isolated",
            "marginCoin": "USDT",
            "size": "0.01",
            "side": "buy",
            "tradeSide": "open",
            "orderType": "limit",
            "clientOid": "cid-1",
            "force": "ioc",
            "price": "60000.0",
        })
        self.assertEqual(result.external_order_id, "o-1")

    def test_spot_market_order_is_rejected(self) -> None:
        with self.assertRaisesRegex(BitgetDemoTradingError, "expected one of"):
            open_demo_position(
                symbol="ethusdt",
                inst_type="SPOT",
                is_buy=False,
                size=1,
                order_type="market",
            )

    def test_limit_order_requires_price(self) -> None:
        with self.assertRaisesRegex(BitgetDemoTradingError, "limit order requires"):
            open_demo_position(
                symbol="BTCUSDT",
                inst_type="USDT-FUTURES",
                is_buy=True,
                size=1,
                order_type="limit",
            )


if __name__ == "__main__":
    unittest.main()
