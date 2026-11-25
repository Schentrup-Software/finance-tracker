import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  route("/login", "routes/login.tsx"),
  layout("routes/app-layout.tsx", [
    index("routes/index.tsx"),
    route("/budget", "routes/budget.tsx"),
    route("/debts", "routes/debts.tsx"),
    route("/assets", "routes/assets.tsx"),
    route("/household", "routes/household.tsx"),
    route("/api-tokens", "routes/api-tokens.tsx"),
  ]),
] satisfies RouteConfig;
