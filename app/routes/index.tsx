import { redirect } from "react-router";

export function clientLoader() {
  return redirect("/budget");
}

export default function Index() {
  return null;
}
