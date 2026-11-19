import { redirect } from "next/navigation";

/** Internal system: there is no public site. The login page forwards signed-in users to /app. */
export default function Home() {
  redirect("/login");
}
