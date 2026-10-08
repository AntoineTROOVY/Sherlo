import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Languages } from 'lucide-react';
import { CustomSelect } from '../components/CustomSelect';
import { languageOptions, resolveSupportedLanguage, type SupportedLanguage } from '../i18n';
import { API_BASE_URL } from '../services/api';
import './Login.css';

interface LoginProps {
  onLogin: (role?: string, engineType?: string, scoped?: boolean) => void;
}

type AuthMode = 'sign-in' | 'sign-up' | 'forgot' | 'reset' | 'verify-otp';

export function Login({ onLogin }: LoginProps) {
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<AuthMode>('sign-in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [otp, setOtp] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const currentLang = resolveSupportedLanguage(i18n.resolvedLanguage || i18n.language);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const urlError = params.get('error');
    if (token) {
      setResetToken(token);
      setMode('reset');
      setError('');
      setSuccessMessage('');
    } else if (urlError === 'INVALID_TOKEN') {
      setMode('reset');
      setError(t('login.invalidResetToken'));
    }
    if (token || urlError) {
      params.delete('token');
      params.delete('error');
      const rest = params.toString();
      const next = `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`;
      window.history.replaceState({}, '', next);
    }
  }, [t]);

  const changeLanguage = (language: SupportedLanguage) => {
    void i18n.changeLanguage(language);
  };

  const resetRedirectUrl = () => `${window.location.origin}${window.location.pathname}`;

  const finishSession = async () => {
    const response = await fetch(`${API_BASE_URL}/auth/validate`, {
      method: 'POST',
      credentials: 'include',
    });
    if (response.ok) {
      const data: { role?: string; engineType?: string; scoped?: unknown } = await response.json().catch(() => ({}));
      onLogin(
        data.role,
        typeof data.engineType === 'string' ? data.engineType : undefined,
        data.scoped === true,
      );
      return true;
    }
    const errorData: { message?: unknown } = await response.json().catch(() => ({}));
    const reason = response.status < 500 && typeof errorData.message === 'string' ? errorData.message : '';
    setError(reason || t('login.connectionError'));
    return false;
  };

  const sendVerificationOtp = async (targetEmail: string) => {
    const response = await fetch(`${API_BASE_URL}/account/email-otp/send-verification-otp`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: targetEmail, type: 'email-verification' }),
    });
    if (!response.ok) {
      const errorData: { message?: unknown } = await response.json().catch(() => ({}));
      const reason = response.status < 500 && typeof errorData.message === 'string' ? errorData.message : '';
      setError(reason || t('login.connectionError'));
      return false;
    }
    setSuccessMessage(t('login.otpSent'));
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    const trimmedName = name.trim();
    setSuccessMessage('');

    if (mode === 'verify-otp') {
      if (!trimmedEmail) {
        setError(t('login.emailRequired'));
        return;
      }
      const code = otp.replace(/\s/g, '');
      if (!/^\d{6}$/.test(code)) {
        setError(t('login.otpInvalid'));
        return;
      }
      setIsLoading(true);
      setError('');
      try {
        const response = await fetch(`${API_BASE_URL}/account/email-otp/verify-email`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: trimmedEmail, otp: code }),
        });
        if (!response.ok) {
          const errorData: { message?: unknown; code?: unknown } = await response.json().catch(() => ({}));
          const reason = response.status < 500 && typeof errorData.message === 'string' ? errorData.message : '';
          if (typeof errorData.code === 'string' && errorData.code.includes('OTP')) {
            setError(reason || t('login.otpInvalid'));
          } else {
            setError(reason || t('login.connectionError'));
          }
          return;
        }
        setOtp('');
        setSuccessMessage(t('login.emailVerifiedSuccess'));
        await finishSession();
      } catch {
        setError(t('login.connectionError'));
      } finally {
        setIsLoading(false);
      }
      return;
    }

    if (mode === 'forgot') {
      if (!trimmedEmail) {
        setError(t('login.emailRequired'));
        return;
      }
      setIsLoading(true);
      setError('');
      try {
        const response = await fetch(`${API_BASE_URL}/account/request-password-reset`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: trimmedEmail, redirectTo: resetRedirectUrl() }),
        });
        if (!response.ok) {
          const errorData: { message?: unknown } = await response.json().catch(() => ({}));
          const reason = response.status < 500 && typeof errorData.message === 'string' ? errorData.message : '';
          setError(reason || t('login.connectionError'));
          return;
        }
        setSuccessMessage(t('login.resetEmailSent'));
      } catch {
        setError(t('login.connectionError'));
      } finally {
        setIsLoading(false);
      }
      return;
    }

    if (mode === 'reset') {
      if (!resetToken) {
        setError(t('login.invalidResetToken'));
        return;
      }
      if (!password) {
        setError(t('login.passwordRequired'));
        return;
      }
      if (password !== confirmPassword) {
        setError(t('login.passwordsMismatch'));
        return;
      }
      setIsLoading(true);
      setError('');
      try {
        const response = await fetch(`${API_BASE_URL}/account/reset-password`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newPassword: password, token: resetToken }),
        });
        if (!response.ok) {
          const errorData: { message?: unknown } = await response.json().catch(() => ({}));
          const reason = response.status < 500 && typeof errorData.message === 'string' ? errorData.message : '';
          setError(reason || t('login.invalidResetToken'));
          return;
        }
        setPassword('');
        setConfirmPassword('');
        setResetToken('');
        setMode('sign-in');
        setSuccessMessage(t('login.passwordResetSuccess'));
      } catch {
        setError(t('login.connectionError'));
      } finally {
        setIsLoading(false);
      }
      return;
    }

    if (!trimmedEmail) {
      setError(t('login.emailRequired'));
      return;
    }
    if (!password) {
      setError(t('login.passwordRequired'));
      return;
    }
    if (mode === 'sign-up' && !trimmedName) {
      setError(t('login.nameRequired'));
      return;
    }
    setIsLoading(true);
    setError('');

    try {
      const signResponse = await fetch(
        `${API_BASE_URL}/account/${mode === 'sign-up' ? 'sign-up' : 'sign-in'}/email`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: trimmedEmail,
            password,
            ...(mode === 'sign-up' ? { name: trimmedName } : {}),
          }),
        },
      );

      const signData: { token?: string | null; user?: { emailVerified?: boolean } } = await signResponse
        .json()
        .catch(() => ({}));

      if (!signResponse.ok) {
        const errorData = signData as { message?: unknown };
        const reason = typeof errorData.message === 'string' ? errorData.message : '';
        const emailNotVerified =
          signResponse.status === 403 &&
          (reason.toLowerCase().includes('email not verified') || reason.toLowerCase().includes('e-mail'));
        if (emailNotVerified) {
          setMode('verify-otp');
          setError('');
          setSuccessMessage(t('login.otpSentSignIn'));
          return;
        }
        setError(
          reason ||
            t(
              signResponse.status === 401
                ? 'login.invalidCredentials'
                : signResponse.status >= 500
                  ? 'login.serverError'
                  : 'login.connectionError',
            ),
        );
        return;
      }

      if (mode === 'sign-up' && signData.user?.emailVerified === false) {
        setMode('verify-otp');
        setError('');
        setSuccessMessage(t('login.otpSent'));
        return;
      }

      await finishSession();
    } catch {
      setError(t('login.connectionError'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo">
          <img src="/logo.png" alt="Sherlo" className="logo-icon" />
        </div>

        <div className="login-language">
          <Languages size={18} />
          <CustomSelect
            value={currentLang}
            onChange={value => changeLanguage(value as SupportedLanguage)}
            options={languageOptions.map(opt => ({ value: opt.value, label: opt.label }))}
            ariaLabel={t('common.language')}
          />
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          {mode === 'reset' && (
            <p className="login-mode-hint">{t('login.resetPasswordTitle')}</p>
          )}
          {mode === 'forgot' && (
            <p className="login-mode-hint">{t('login.forgotPasswordHint')}</p>
          )}
          {mode === 'verify-otp' && (
            <p className="login-mode-hint">{t('login.verifyOtpHint')}</p>
          )}
          {successMessage && <p className="login-success">{successMessage}</p>}

          {mode === 'sign-up' && (
            <div className="input-group">
              <label htmlFor="name">{t('login.name')}</label>
              <div className="input-wrapper">
                <input
                  id="name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={t('login.namePlaceholder')}
                  className={error ? 'error' : ''}
                />
              </div>
            </div>
          )}

          {mode !== 'verify-otp' && (
            <div className="input-group">
              <label htmlFor="email">{t('login.email')}</label>
              <div className="input-wrapper">
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder={t('login.emailPlaceholder')}
                  className={error ? 'error' : ''}
                />
              </div>
            </div>
          )}

          {mode === 'verify-otp' && (
            <>
              <div className="input-group">
                <label htmlFor="verifyEmail">{t('login.email')}</label>
                <div className="input-wrapper">
                  <input id="verifyEmail" type="email" value={email} readOnly className="readonly-input" />
                </div>
              </div>
              <div className="input-group">
                <label htmlFor="otp">{t('login.otpCode')}</label>
                <div className="input-wrapper">
                  <input
                    id="otp"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={otp}
                    onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    className={`otp-input${error ? ' error' : ''}`}
                  />
                </div>
              </div>
            </>
          )}

          {(mode === 'sign-in' || mode === 'sign-up' || mode === 'reset') && (
            <div className="input-group">
              <div className="password-label-row">
                <label htmlFor="password">
                  {mode === 'reset' ? t('login.newPassword') : t('login.password')}
                </label>
                {mode === 'sign-in' && (
                  <button
                    type="button"
                    className="login-forgot"
                    onClick={() => {
                      setMode('forgot');
                      setError('');
                      setSuccessMessage('');
                    }}
                  >
                    {t('login.forgotPassword')}
                  </button>
                )}
              </div>
              <div className="input-wrapper">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className={error ? 'error' : ''}
                />
                <button
                  type="button"
                  className="toggle-visibility"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
                >
                  {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
            </div>
          )}

          {mode === 'reset' && (
            <div className="input-group">
              <label htmlFor="confirmPassword">{t('login.confirmPassword')}</label>
              <div className="input-wrapper">
                <input
                  id="confirmPassword"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  className={error ? 'error' : ''}
                />
              </div>
            </div>
          )}

          {error && <span className="error-message">{error}</span>}

          <button type="submit" className="connect-btn" disabled={isLoading}>
            {isLoading
              ? t(
                  mode === 'sign-up'
                    ? 'login.creating'
                    : mode === 'forgot'
                      ? 'login.sendingReset'
                      : mode === 'reset'
                        ? 'login.resetting'
                        : mode === 'verify-otp'
                          ? 'login.verifyingOtp'
                          : 'login.signingIn',
                )
              : t(
                  mode === 'sign-up'
                    ? 'login.signUp'
                    : mode === 'forgot'
                      ? 'login.sendResetLink'
                      : mode === 'reset'
                        ? 'login.resetPassword'
                        : mode === 'verify-otp'
                          ? 'login.verifyOtp'
                          : 'login.signIn',
                )}
          </button>

          {mode === 'verify-otp' && (
            <button
              type="button"
              className="login-switch"
              disabled={isLoading}
              onClick={() => {
                void (async () => {
                  const target = email.trim();
                  if (!target) {
                    setError(t('login.emailRequired'));
                    return;
                  }
                  setIsLoading(true);
                  setError('');
                  await sendVerificationOtp(target);
                  setIsLoading(false);
                })();
              }}
            >
              {t('login.resendOtp')}
            </button>
          )}

          {mode === 'sign-in' && (
            <button
              type="button"
              className="login-switch"
              onClick={() => {
                setMode('sign-up');
                setError('');
                setSuccessMessage('');
              }}
            >
              {t('login.switchToSignUp')}
            </button>
          )}
          {mode === 'sign-up' && (
            <button
              type="button"
              className="login-switch"
              onClick={() => {
                setMode('sign-in');
                setError('');
                setSuccessMessage('');
              }}
            >
              {t('login.switchToSignIn')}
            </button>
          )}
          {(mode === 'forgot' || mode === 'reset' || mode === 'verify-otp') && (
            <button
              type="button"
              className="login-switch"
              onClick={() => {
                setMode('sign-in');
                setError('');
                setSuccessMessage('');
                setPassword('');
                setConfirmPassword('');
                setResetToken('');
                setOtp('');
              }}
            >
              {t('login.backToSignIn')}
            </button>
          )}
        </form>

        <p className="login-help">
          {t('login.help')}{' '}
          <a href="https://docs.open-wa.org" target="_blank" rel="noopener noreferrer">
            {t('login.viewDocs')}
          </a>
        </p>
      </div>
    </div>
  );
}
