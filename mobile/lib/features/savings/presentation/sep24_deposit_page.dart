# SEP-24 anchor deposit flow (mobile)

Implements the state management for **fiat → USDC deposits through a SEP-24
anchor**: collecting the deposit parameters, asking the backend for the
anchor's interactive URL, hosting that page in an in-app WebView, and tracking
the transaction status live until it succeeds or fails.

## Files

| File | Role |
| --- | --- |
| `lib/features/savings/bloc/sep24_bloc.dart` | `Sep24Bloc` — the BLoC state machine (`Initial → Loading → WebViewOpen → Success/Error`), event handling, WebView callback interpretation and backend status polling. Re-exports the states and events. |
| `lib/features/savings/bloc/sep24_state.dart` | Sealed `Sep24State` hierarchy: `Sep24Initial`, `Sep24Loading`, `Sep24WebViewOpen`, `Sep24Success`, `Sep24Error`. |
| `lib/features/savings/bloc/sep24_event.dart` | `StartSep24Deposit`, `Sep24WebViewNavigation`, `Sep24StatusRefreshRequested`, `Sep24DepositCancelled`, `Sep24DepositReset`. |
| `lib/features/savings/data/sep24_repository.dart` | `Sep24Repository` — the backend/anchor calls (`requestDepositTicket`, `fetchTransactionStatus`) plus `Sep24Exception` / `Sep24StatusUnavailableException`. |
| `lib/features/savings/models/sep24_models.dart` | `Sep24DepositRequest` (validated input), `Sep24DepositTicket` (anchor answer), `Sep24TransactionStatus` (SEP-24 status enum + terminal classification), `Sep24Callback` and `Sep24CallbackParser` (redirect → status). |
| `lib/features/savings/presentation/sep24_webview_page.dart` | `Sep24WebViewPage` — the in-app WebView (via `webview_flutter`), the live status strip, the snackbar alerts, and the navigation interception. `defaultSep24WebViewFactory` is injectable so the page is testable without a platform WebView. |
| `lib/features/savings/presentation/sep24_deposit_page.dart` | `Sep24DepositPage` — the amount/asset/customer form that starts the flow and opens the WebView page. |
| `lib/core/network/api_client.dart` | Added `getWithRetry` (idempotent GET with the same retry/backoff + error mapping) used by status polling. |
| `android/app/src/main/AndroidManifest.xml` | `INTERNET` permission for release builds (the WebView and API calls need it). |

## Flow

```text
Sep24DepositPage ──startDeposit()──▶ Sep24Bloc
                                        │  POST {base}{SEP24_DEPOSIT_PATH}
                                        ▼
                                   Sep24Loading
                                        │  { type: interactive_customer_info_needed, url, id }
                                        ▼
                                   Sep24WebViewOpen ──▶ Sep24WebViewPage (WebView)
             non-terminal callbacks │  ▲                       │  anchor redirect
             (status banner)        ▼  │                       ▼
                                   Sep24WebViewOpen ◀── Sep24CallbackParser.tryParse(url)
                                        │  status=completed / status=error|expired|too_small…
                                        ▼
                              Sep24Success │ Sep24Error  →  SnackBar + pop(result)
```

* **Parameter capture** — `Sep24DepositRequest` validates the amount (numeric,
  `> 0`, `>= 1.00`), asset (`USDC` by default) and the optional customer
  fields (`email`, `phone_number`, `account`, `country_code`, plus any extra
  fields the anchor asked for). Invalid input fails in the bloc without
  touching the network.
* **Interactive URL** — `Sep24Repository.requestDepositTicket` POSTs the
  parameters to the backend, which proxies the anchor's `POST /deposit`.
  The answer is parsed per SEP-24: `interactive_customer_info_needed`
  (open the page), `transaction` (no page needed — track the id instead) or
  `error` (show the anchor's message). The in-app callback URL
  (`zendvo://sep24/callback`) is appended as a `?callback=` parameter so the
  anchor can hand the status back to the app; disable with
  `attachCallbackUrl: false`.
* **WebView + callbacks** — `Sep24WebViewPage` renders the anchor page and
  forwards *every* navigation to the bloc. A navigation whose URL matches the
  callback pattern (custom scheme, or an allow-listed host + callback path,
  status in the query **or** the fragment) is consumed by the app and
  prevented from loading as a page; everything else loads normally.
* **Status tracking** — every callback updates `Sep24WebViewOpen.status` /
  `statusMessage`, so the UI shows live progress (`Awaiting your transfer`,
  `Processing with the anchor`, …). In parallel the bloc polls
  `GET {base}{SEP24_STATUS_PATH}?id=<txid>` (default
  `/api/savings/sep24/transaction`). If the backend does not expose that route
  (404), polling is disabled and the WebView redirects stay the source of
  truth — the flow never gets stuck and never shows a bogus error. The anchor
  also pushes the same status changes to `POST /api/webhooks/sep24` server-side.
* **Terminal states** — `completed` ⇒ `Sep24Success` (amount + asset +
  anchor transaction id); `error`, `expired`, `no_market`, `too_small`,
  `too_large`, `refunded` ⇒ `Sep24Error` with the anchor's message and a retry
  affordance. `Sep24Success` is announced with a snackbar and the page pops
  with the state as the route result, so the calling screen can refresh its
  balance. Leaving the page mid-flow calls `cancelDeposit()` and returns to
  `Sep24Initial`.

## Backend contract expected from this client

```http
POST /api/savings/sep24/deposit
Body: { amount, asset_code, asset, kind, lang, email?, phone_number?, account?, country_code?, ...extra }
200:  { "type": "interactive_customer_info_needed", "url": "https://anchor/…", "id": "…" }
      { "type": "transaction", "transaction": { "id": "…", "status": "…" } }
      { "type": "error", "error": "human readable reason" }

GET  /api/savings/sep24/transaction?id=<anchor transaction id>
200:  { "id": "…", "status": "pending_anchor|completed|error|…", "amount_in": "…", "asset_code": "USDC" }
```

Both paths are configurable (`Sep24Repository(depositPath:, statusPath:)` or
`--dart-define=SEP24_DEPOSIT_PATH=…` / `SEP24_STATUS_PATH=…`) and the base URL
uses the same `--dart-define=API_BASE_URL=…` as `SavingsRepository`. The
backend already implements the anchor → server side of SEP-24
(`POST /api/webhooks/sep24`); the two routes above are the mobile-facing
endpoints still to be added there.

## Wiring it into the app

Nothing is wired into `lib/main.dart` yet (the app still runs the default
counter screen and `SavingsRepository` is likewise unused by any screen), so
the feature is intentionally self-contained:

```dart
final bloc = Sep24Bloc(repository: Sep24Repository());

MaterialApp(
  home: Sep24DepositPage(bloc: bloc),
);
// or push the anchor page directly once you already have a ticket:
// BlocProvider.value(value: bloc, child: Sep24WebViewPage(bloc: bloc));
```

## Tests

```bash
cd mobile && flutter pub get && flutter analyze && flutter test
```

* `test/features/savings/bloc/sep24_bloc_test.dart` — 26 tests: the full state
  machine, validation short-circuits, error mapping (congestion vs. 404 vs.
  anchor refusal), callback interpretation, polling, cancel/reset.
* `test/features/savings/presentation/sep24_webview_page_test.dart` — WebView
  page: renders the anchor URL, blocks status handoffs, live status strip,
  retry on failure, cancel on close, pops with the terminal state.
* `test/features/savings/presentation/sep24_deposit_page_test.dart` — form:
  captures and submits parameters, validation, in-flight lock, error display.
* `test/features/savings/data/sep24_repository_test.dart` — real local HTTP
  server: request body, callback parameter handling, custom paths, status
  parsing, 404 → "unavailable", retry on 503.
* `test/core/network/api_client_get_test.dart` — `getWithRetry` backoff,
  non-retried 4xx, auth header.
* `test/features/savings/models/sep24_models_test.dart` — SEP-24 status
  parsing/classification, request validation/serialisation, callback parsing
  (query, fragment, cancellation, allow-listed hosts).
