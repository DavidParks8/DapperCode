import { RouteErrorScreen } from '../navigation/RouteErrorScreen';

export default function NotFoundRoute() {
  return (
    <RouteErrorScreen
      title="Page not found"
      message="This DapperCode link does not match an available screen."
    />
  );
}
