const logoUrl = new URL('/assets/logo-1024.png', import.meta.url).href;

export default function LoadingScreen({ message = 'Preparing your training…' }: { message?: string }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '60vh',
      gap: '1.5rem',
      animation: 'fadeIn 0.4s ease',
    }}>
      <div style={{
        position: 'relative',
        width: 120,
        height: 120,
      }}>
        {/* Rotating gold ring */}
        <div style={{
          position: 'absolute',
          inset: -8,
          borderRadius: '50%',
          border: '2px solid transparent',
          borderTopColor: 'var(--apollo-gold)',
          borderRightColor: 'rgba(212, 165, 55, 0.3)',
          animation: 'spin 1.2s linear infinite',
        }} />
        {/* Logo */}
        <img
          src={logoUrl}
          alt="Apollo"
          style={{
            width: 120,
            height: 120,
            objectFit: 'contain',
            filter: 'drop-shadow(0 4px 12px rgba(212, 165, 55, 0.3))',
            animation: 'breathe 2s ease-in-out infinite',
          }}
        />
      </div>
      <div style={{
        fontFamily: 'var(--font-display)',
        fontSize: 'var(--text-lg)',
        fontWeight: 'var(--weight-bold)' as unknown as number,
        letterSpacing: '0.1em',
        textTransform: 'uppercase' as const,
        background: 'linear-gradient(135deg, var(--apollo-gold-light) 0%, var(--apollo-gold) 50%, var(--apollo-orange) 100%)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
      }}>
        Apollo
      </div>
      <p style={{
        color: 'var(--text-muted)',
        fontSize: 'var(--text-sm)',
        margin: 0,
        animation: 'breathe 2s ease-in-out infinite',
      }}>
        {message}
      </p>
    </div>
  );
}
