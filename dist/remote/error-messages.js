// User-facing auth/session failure copy for the GUI (REQ-12). We never invent new wording for the
// cases the stdio plugin already handles — the AuthManager re-authorize copy and the withAdminGuard
// admin-role copy surface verbatim through the MCP tool-error channel. This module only adds the
// one string the SDK does not provide (the not-yet-authorized hint) and a classifier that turns any
// thrown auth/session error into an actionable line, never a stack trace.
export const CONNECTOR_AUTHORIZE_HINT = 'Authorize the Zendesk connector (complete the OAuth sign-in) and try again.';
export function describeAuthError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    // AuthManager copy ("...Please re-authorize." / "No Zendesk authorization found...") and
    // withAdminGuard copy ("...requires an admin role...") are already actionable — pass them through.
    if (/re-authorize|No Zendesk authorization|requires an admin role/i.test(msg))
        return msg;
    if (/unauthorized|invalid_token|missing a zendesk identity/i.test(msg))
        return CONNECTOR_AUTHORIZE_HINT;
    return msg;
}
