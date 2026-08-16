import { createContext, Fragment, type ReactNode } from 'react';

const progress = { value: 0 };

export function Drawer({
  children,
  renderDrawerContent,
}: {
  children: ReactNode;
  renderDrawerContent: () => ReactNode;
}) {
  return (
    <Fragment>
      {children}
      {renderDrawerContent()}
    </Fragment>
  );
}

export const DrawerProgressContext = createContext(progress);
export const useDrawerProgress = () => progress;
