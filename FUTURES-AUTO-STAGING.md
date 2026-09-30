# Separate Futures executor

The initial planning-only draft is now the independent directional executor
in v6.9.36. See [deployment and execution behavior](V6.9.36-FUTURES-AUTO.md).

It uses its own subaccount credentials, Supabase journal/control/lease,
AWS service and Telegram `/futures*` controls. Existing paper Futures and
fade orders are separate. It supports LONG and SHORT, five positions maximum,
modeled $5 whole-position target and min($5, 1% equity) modeled stop cap.

Mocked tests do not prove exchange fills or profitability. Live activation
requires configuring the separate account on AWS and matching Railway's
FUTURES_AUTO_ENVIRONMENT; merging alone does not start live orders.
