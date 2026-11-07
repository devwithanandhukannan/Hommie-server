import { Loan, LoanPayment } from '../models/index.js';
import { badRequest } from '../lib/errors.js';

/** Interest for one month on the current balance, then the rest of the payment reduces principal. */
export async function recordLoanPayment(loan, { paidOn, amount, billInstanceId }) {
  if (loan.closedAt) throw badRequest('This loan is already closed');
  const monthlyRate = loan.interestRate / 12 / 100;
  const interestPart = Math.min(amount, Math.round(loan.outstanding * monthlyRate));
  const principalPart = Math.min(loan.outstanding, Math.max(0, amount - interestPart));
  const outstanding = loan.outstanding - principalPart;
  const payment = await LoanPayment.create({ familyId: loan.familyId, loanId: loan._id, paidOn, amount, interestPart, principalPart, billInstanceId });
  await Loan.updateOne({ _id: loan._id }, { $set: { outstanding, ...(outstanding === 0 ? { closedAt: new Date() } : {}) } });
  return payment;
}

/** Standard EMI formula (paise). Used to suggest an EMI when the user only knows principal, rate, tenure. */
export function suggestEmi(principal, annualRate, months) {
  const r = annualRate / 12 / 100;
  if (r === 0) return Math.round(principal / months);
  return Math.round((principal * r * (1 + r) ** months) / ((1 + r) ** months - 1));
}
