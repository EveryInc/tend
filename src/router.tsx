import { Navigate, createRootRoute, createRoute, createRouter, useParams } from "@tanstack/react-router";
import App, { type AttentionScreen, type WorkspaceTab } from "./App";

const rootRoute = createRootRoute();

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => <Navigate to="/feed/$feedId" params={{ feedId: "inbox" }} replace />,
});

const feedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/feed/$feedId",
  component: () => <RouteApp screen="feed" workspaceTab="feed" />,
});

const feedPromptsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/feed/$feedId/prompts",
  component: () => <RouteApp screen="workspace" workspaceTab="feed" />,
});

const globalPromptsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/feed/$feedId/prompts/global",
  component: () => <RouteApp screen="workspace" workspaceTab="global" />,
});

const learningsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/feed/$feedId/learnings",
  component: () => <RouteApp screen="learnings" workspaceTab="feed" />,
});

function RouteApp({ screen, workspaceTab }: { screen: AttentionScreen; workspaceTab: WorkspaceTab }) {
  const { feedId } = useParams({ strict: false }) as { feedId: string };
  return <App feedId={feedId} screen={screen} workspaceTab={workspaceTab} />;
}

const routeTree = rootRoute.addChildren([
  indexRoute,
  feedRoute,
  feedPromptsRoute,
  globalPromptsRoute,
  learningsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
