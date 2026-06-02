import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import App, { OAuthConsentPage, SignInPage, type AttentionRouteScreen } from "./App";

function feedSearch(search: Record<string, unknown>): { feed: string } {
  return { feed: typeof search.feed === "string" && search.feed.length ? search.feed : "inbox" };
}

function workspaceSearch(search: Record<string, unknown>): { tab: "feed" | "global" } {
  return { tab: search.tab === "global" ? "global" : "feed" };
}

function RoutedAttentionApp({ feedId, screen, workspaceTab }: { feedId: string; screen: AttentionRouteScreen; workspaceTab?: "feed" | "global" }) {
  return <App feedId={feedId} screen={screen} workspaceTab={workspaceTab} />;
}

const rootRoute = createRootRoute({
  component: Outlet,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: feedSearch,
  component: function IndexRoute() {
    const search = indexRoute.useSearch();
    return <RoutedAttentionApp feedId={search.feed} screen="feed" />;
  },
});

const feedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "feed/$feedId",
  component: function FeedRoute() {
    const { feedId } = feedRoute.useParams();
    return <RoutedAttentionApp feedId={feedId} screen="feed" />;
  },
});

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "workspace/$feedId",
  validateSearch: workspaceSearch,
  component: function WorkspaceRoute() {
    const { feedId } = workspaceRoute.useParams();
    const search = workspaceRoute.useSearch();
    return <RoutedAttentionApp feedId={feedId} screen="workspace" workspaceTab={search.tab} />;
  },
});

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "agents/$feedId",
  component: function AgentsRoute() {
    const { feedId } = agentsRoute.useParams();
    return <RoutedAttentionApp feedId={feedId} screen="agents" />;
  },
});

const learningsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "learnings/$feedId",
  component: function LearningsRoute() {
    const { feedId } = learningsRoute.useParams();
    return <RoutedAttentionApp feedId={feedId} screen="learnings" />;
  },
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "sign-in",
  component: SignInPage,
});

const oauthConsentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "oauth/consent",
  component: OAuthConsentPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  feedRoute,
  workspaceRoute,
  agentsRoute,
  learningsRoute,
  signInRoute,
  oauthConsentRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
