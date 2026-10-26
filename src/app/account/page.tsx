import type { Metadata } from "next";
import { AccountDashboard } from "./account-client";

export const metadata: Metadata = {
  title: "Your account", // "Your account · Thun Murex", from the layout's title template
  description: "Sign in to Thun Murex: your API keys, what your plan allows, and what you've used.",
};

export default function AccountPage() {
  return <AccountDashboard />;
}
