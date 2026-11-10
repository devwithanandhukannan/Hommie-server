import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transporter = null;

const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Outside production, when SMTP is not configured, codes are logged and kept in memory so local development
 * and tests work without a mail server. In production a missing SMTP config is a hard error.
 */
export const devOutbox = new Map();
const canFake = () => !config.isProd && (!config.smtp.user || !config.smtp.pass);

function getTransporter() {
  if (!transporter) {
    if (!config.smtp.user || !config.smtp.pass) {
      console.warn('[mail] SMTP credentials are not configured. Emails will not be sent.');
      return null;
    }
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: {
        user: config.smtp.user,
        pass: config.smtp.pass,
      },
    });
  }
  return transporter;
}

/**
 * Sends a 6-digit verification OTP email to the user for account registration.
 */
export async function sendOtpEmail(toEmail, otp, name = '') {
  if (canFake()) {
    devOutbox.set(String(toEmail).toLowerCase(), otp);
    if (!config.isTest) console.warn(`[mail:dev] verification code for ${toEmail}: ${otp}`);
    return;
  }
  const mailer = getTransporter();
  if (!mailer) {
    throw new Error('Email service is not configured on the server');
  }

  const subject = `${otp} is your Hommi verification code`;
  const firstName = escapeHtml(name ? name.split(' ')[0] : 'there');
  const plainFirst = name ? name.split(' ')[0] : 'there';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #F8FAFC; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1E293B;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #F8FAFC; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" max-width="500" cellpadding="0" cellspacing="0" style="max-width: 500px; background-color: #FFFFFF; border-radius: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.06); overflow: hidden; border: 1px solid #E2E8F0;">
          <tr>
            <td style="background: linear-gradient(135deg, #0D4734, #126349); padding: 32px 28px; text-align: center;">
              <h1 style="margin: 0; color: #FFFFFF; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">Hommi</h1>
              <p style="margin: 6px 0 0; color: #A7F3D0; font-size: 13px;">Your Private Family Space</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 32px 28px;">
              <h2 style="margin: 0 0 12px; font-size: 19px; font-weight: 600; color: #0F172A;">Verify your email</h2>
              <p style="margin: 0 0 24px; font-size: 14.5px; line-height: 1.5; color: #475569;">
                Hi ${firstName}, welcome to Hommi! Use the verification code below to complete your registration:
              </p>
              
              <div style="background-color: #F1F5F9; border-radius: 14px; padding: 20px; text-align: center; margin: 0 0 24px; border: 1px dashed #CBD5E1;">
                <span style="font-family: 'SF Mono', Monaco, Consolas, monospace; font-size: 34px; font-weight: 800; letter-spacing: 8px; color: #0D4734; display: inline-block;">
                  ${otp}
                </span>
                <p style="margin: 8px 0 0; font-size: 12px; color: #64748B;">This code is valid for <b>10 minutes</b>.</p>
              </div>

              <p style="margin: 0; font-size: 13px; line-height: 1.5; color: #64748B;">
                If you didn't request this code, you can safely ignore this email. Never share this code with anyone.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 28px; background-color: #F8FAFC; border-top: 1px solid #E2E8F0; text-align: center; font-size: 12px; color: #94A3B8;">
              Hommi &copy; ${new Date().getFullYear()} &middot; Private, encrypted and safe for your family.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;

  const text = `Hi ${plainFirst},\n\nYour Hommi verification code is: ${otp}\n\nThis code expires in 10 minutes.\n\nIf you did not request this, please ignore this email.\n\nHommi`;

  await mailer.sendMail({
    from: config.smtp.from,
    to: toEmail,
    subject,
    text,
    html,
  });
}

/**
 * Sends a secure password reset link to the user's email.
 */
export async function sendPasswordResetEmail(toEmail, resetUrl, name = '') {
  if (canFake()) {
    devOutbox.set(`reset:${String(toEmail).toLowerCase()}`, resetUrl);
    if (!config.isTest) console.warn(`[mail:dev] password reset link for ${toEmail}: ${resetUrl}`);
    return;
  }
  const mailer = getTransporter();
  if (!mailer) {
    throw new Error('Email service is not configured on the server');
  }

  const subject = 'Reset your Hommi password';
  const firstName = escapeHtml(name ? name.split(' ')[0] : 'there');
  const plainFirst = name ? name.split(' ')[0] : 'there';
  const safeUrl = escapeHtml(resetUrl);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #F8FAFC; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1E293B;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #F8FAFC; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" max-width="500" cellpadding="0" cellspacing="0" style="max-width: 500px; background-color: #FFFFFF; border-radius: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.06); overflow: hidden; border: 1px solid #E2E8F0;">
          <tr>
            <td style="background: linear-gradient(135deg, #0D4734, #126349); padding: 32px 28px; text-align: center;">
              <h1 style="margin: 0; color: #FFFFFF; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">Hommi</h1>
              <p style="margin: 6px 0 0; color: #A7F3D0; font-size: 13px;">Password Assistance</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 32px 28px;">
              <h2 style="margin: 0 0 12px; font-size: 19px; font-weight: 600; color: #0F172A;">Reset your password</h2>
              <p style="margin: 0 0 24px; font-size: 14.5px; line-height: 1.5; color: #475569;">
                Hi ${firstName}, we received a request to reset your password for Hommi. Click the button below to choose a new password:
              </p>
              
              <div style="text-align: center; margin: 30px 0;">
                <a href="${safeUrl}" style="background-color: #0D4734; color: #FFFFFF; text-decoration: none; padding: 14px 30px; border-radius: 12px; font-weight: 600; font-size: 15px; display: inline-block; box-shadow: 0 2px 8px rgba(13, 71, 52, 0.25);">
                  Reset Password
                </a>
              </div>

              <p style="margin: 0 0 14px; font-size: 13px; line-height: 1.5; color: #64748B;">
                This link is valid for <b>1 hour</b> and can only be used once.
              </p>
              <p style="margin: 0; font-size: 12px; line-height: 1.5; color: #94A3B8; word-break: break-all;">
                Or copy and paste this link into your browser:<br>
                <a href="${safeUrl}" style="color: #0D4734;">${safeUrl}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 28px; background-color: #F8FAFC; border-top: 1px solid #E2E8F0; text-align: center; font-size: 12px; color: #94A3B8;">
              If you did not ask to reset your password, please ignore this email. Your password will remain unchanged.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;

  const text = `Hi ${plainFirst},\n\nWe received a request to reset your password for Hommi. Use the link below to set a new password:\n\n${resetUrl}\n\nThis link expires in 1 hour.\n\nIf you did not request this, please ignore this email.\n\nHommi`;

  await mailer.sendMail({
    from: config.smtp.from,
    to: toEmail,
    subject,
    text,
    html,
  });
}

