type MailUser = { email: string; name?: string | null };

export function resolveResendConfig(env: NodeJS.ProcessEnv): { apiKey: string; from: string } | null {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) return null;
  const from = env.RESEND_FROM?.trim() || 'Sherlo <onboarding@resend.dev>';
  return { apiKey, from };
}

/** @deprecated use resolveResendConfig */
export const resolveResetEmailConfig = resolveResendConfig;

async function sendHtmlEmail(config: { apiKey: string; from: string }, to: string, subject: string, html: string): Promise<void> {
  const { Resend } = await import('resend');
  const resend = new Resend(config.apiKey);
  const result = await resend.emails.send({ from: config.from, to, subject, html });
  if (result.error) {
    throw new Error(result.error.message);
  }
}

export function createSendResetPassword(env: NodeJS.ProcessEnv) {
  const config = resolveResendConfig(env);
  if (!config) return undefined;

  return async (data: { user: MailUser; url: string; token: string }): Promise<void> => {
    const greeting = data.user.name?.trim() ? `Hi ${data.user.name.trim()},` : 'Hi,';
    await sendHtmlEmail(
      config,
      data.user.email,
      'Reset your Sherlo password',
      `<p>${greeting}</p>
<p>We received a request to reset your Sherlo password.</p>
<p><a href="${data.url}">Choose a new password</a></p>
<p>If you did not ask for this, you can ignore this email.</p>
<p>This link expires in one hour.</p>`,
    );
  };
}

export type VerificationOtpType = 'sign-in' | 'email-verification' | 'forget-password' | 'change-email';

export function createSendVerificationOTP(env: NodeJS.ProcessEnv) {
  const config = resolveResendConfig(env);
  if (!config) {
    return async (): Promise<void> => {
      throw new Error('RESEND_API_KEY is not configured');
    };
  }

  return async (data: { email: string; otp: string; type: VerificationOtpType }): Promise<void> => {
    const subject =
      data.type === 'email-verification'
        ? 'Verify your Sherlo account'
        : data.type === 'forget-password'
          ? 'Sherlo password reset code'
          : 'Your Sherlo verification code';
    const intro =
      data.type === 'email-verification'
        ? 'Enter this code to verify your email and finish creating your Sherlo account:'
        : 'Enter this verification code:';
    await sendHtmlEmail(
      config,
      data.email,
      subject,
      `<p>${intro}</p>
<p style="font-size:28px;font-weight:700;letter-spacing:0.25em;margin:24px 0">${data.otp}</p>
<p>This code expires in 5 minutes. If you did not request it, you can ignore this email.</p>`,
    );
  };
}
