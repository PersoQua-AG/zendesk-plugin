// src/tools/business-rules.ts
// M4 Business Rules barrel. The implementation is split across business-rules/{views,macros,
// rules}.ts (views read-only; macros preview/apply; rules create/update engine). This barrel
// re-exports the tool surface so existing importers stay stable after the split.
export * from './business-rules/views.js';
export * from './business-rules/macros.js';
export * from './business-rules/rules.js';
