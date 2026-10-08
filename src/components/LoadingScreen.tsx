import logo256 from '../assets/logo-256.png';

/**
 * Boot / page loading indicator. Fades in after 150 ms so a fast boot (usually
 * < 50 ms) doesn't flash it; the global reduced-motion rule stops the spin.
 */
export default function LoadingScreen({ message = 'Preparing your training…' }: { message?: string }) {
  return (
    <div role="status" aria-live="polite" className="loading-screen">
      <div className="loading-screen-mark">
        {/* Rotating gold ring */}
        <div className="loading-screen-ring" aria-hidden="true" />
        {/* The PNG has white corners: show it as a circle */}
        <img src={logo256} alt="" width={120} height={120} className="loading-screen-logo" />
      </div>
      <div className="loading-screen-name" aria-hidden="true">Apollo</div>
      <p className="loading-screen-message">{message}</p>
    </div>
  );
}
