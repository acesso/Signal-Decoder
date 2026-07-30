import { trackEvent } from '../analytics';

describe('trackEvent', () => {
  afterEach(() => { delete (window as { gtag?: unknown }).gtag; });

  it('forwards to window.gtag when present', () => {
    const gtag = jest.fn();
    (window as { gtag?: typeof gtag }).gtag = gtag;

    trackEvent('adif_export', { qso_count: 5 });

    expect(gtag).toHaveBeenCalledWith('event', 'adif_export', { qso_count: 5 });
  });

  it('is a no-op when gtag was never initialized (dev/test builds)', () => {
    expect(() => trackEvent('decode_start', { mode: 'ft' })).not.toThrow();
  });
});
