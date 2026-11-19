/** Plain-language status for an expense, including who ends up paying once it is approved. */
export function expenseStatusLabel(status: "submitted" | "approved" | "rejected", companyBears: boolean): string {
  if (status === "submitted") return "Waiting for review";
  if (status === "rejected") return "Rejected";
  return companyBears ? "Approved: the company pays" : "Approved: not charged to the company";
}
