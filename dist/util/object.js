// Drop keys whose value is `undefined`. Write tools count DEFINED fields before a PUT so a
// payload like {role: undefined} — which JSON.stringify would silently drop to {} — cannot
// slip past a no-op guard and fire an empty update against the API.
export function stripUndefined(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined));
}
