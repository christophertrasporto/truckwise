import type { Metadata } from "next";
import { requireTenant } from "@/server/auth/current";
import { can } from "@/server/policy";
import { listMembers } from "@/server/services/members";
import { MemberForm } from "./member-form";

export const metadata: Metadata = { title: "Team" };

const roleLabel: Record<string, string> = {
  owner: "Owner",
  ops_manager: "Operations manager",
  dispatcher: "Dispatcher",
  accountant: "Accountant",
  driver: "Driver",
  sub_owner: "Owner",
  sub_manager: "Manager",
  sub_driver: "Driver",
};

export default async function TeamPage() {
  const actor = await requireTenant();
  if (!can(actor, "member:read")) return <div className="empty">Your role does not include the team list.</div>;
  const members = await listMembers(actor);
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Team</h1>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.userId}>
              <td>{m.name}</td>
              <td>{m.email}</td>
              <td>{roleLabel[m.role] ?? m.role}{m.status === "disabled" ? " (disabled)" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {can(actor, "member:manage") && <MemberForm partner={actor.tenantKind === "subcontractor"} />}
    </div>
  );
}
