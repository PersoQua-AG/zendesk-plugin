// tests/tools/analytics-business-hours-config-gaps.test.ts
// QA/M6 config-crash pins. Previously these documented a DEFECT: parseReportConfig performed
// FORMAT validation only, so a non-existent IANA timezone or a semantically inverted work_hours
// window survived boot and then threw at zendesk_report runtime. The M6 fix makes parseReportConfig
// DEGRADE such configs to the safe default AND warn (never crash the report). These tests now pin
// the FIXED behavior — the flip from GAP→degrade is the visible, intentional change.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseReportConfig,
  businessMinutesBetween,
  DEFAULT_BUSINESS_HOURS,
  type BusinessHoursConfig,
} from '../../src/tools/analytics/business-hours.js';

const anInterval = (cfg: BusinessHoursConfig) =>
  businessMinutesBetween(Date.UTC(2026, 2, 10, 10, 0), Date.UTC(2026, 2, 10, 12, 0), cfg);

afterEach(() => vi.restoreAllMocks());

describe('parseReportConfig config-crash guards (fixed)', () => {
  it('degrades a non-existent IANA timezone to the default and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = parseReportConfig({ ZENDESK_TIMEZONE: 'Garbage/Nowhere' });
    expect(cfg.timeZone).toBe(DEFAULT_BUSINESS_HOURS.timeZone);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Garbage/Nowhere'); // names the bad value
  });

  it('a degraded timezone no longer throws at report runtime', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = parseReportConfig({ ZENDESK_TIMEZONE: 'Garbage/Nowhere' });
    expect(() => anInterval(cfg)).not.toThrow();
  });

  it('degrades inverted work_hours to the default and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = parseReportConfig({ ZENDESK_WORK_HOURS: '{"start":"17:00","end":"09:00"}' });
    expect(cfg.workHours).toEqual(DEFAULT_BUSINESS_HOURS.workHours);
    expect(() => anInterval(cfg)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/17:00|09:00/);
  });

  it('degrades equal start/end work_hours to the default and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = parseReportConfig({ ZENDESK_WORK_HOURS: '{"start":"09:00","end":"09:00"}' });
    expect(cfg.workHours).toEqual(DEFAULT_BUSINESS_HOURS.workHours);
    expect(() => anInterval(cfg)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: out-of-range HH:MM (fails the format regex) still degrades to default', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = parseReportConfig({ ZENDESK_WORK_HOURS: '{"start":"25:00","end":"30:00"}' });
    expect(cfg.workHours).toEqual(DEFAULT_BUSINESS_HOURS.workHours);
  });

  it('preserves a valid non-default timezone without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = parseReportConfig({ ZENDESK_TIMEZONE: 'Europe/Berlin' });
    expect(cfg.timeZone).toBe('Europe/Berlin');
    expect(warn).not.toHaveBeenCalled();
  });
});
