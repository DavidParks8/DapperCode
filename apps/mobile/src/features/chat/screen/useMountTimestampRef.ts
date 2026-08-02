import { useLayoutEffect, useRef } from 'react';

export function useMountTimestampRef(shouldTimestamp: boolean) {
  const shouldTimestampOnMountRef = useRef(shouldTimestamp);
  const timestampRef = useRef(0);

  useLayoutEffect(() => {
    if (shouldTimestampOnMountRef.current && timestampRef.current === 0) {
      timestampRef.current = Date.now();
    }
  }, []);

  return timestampRef;
}
