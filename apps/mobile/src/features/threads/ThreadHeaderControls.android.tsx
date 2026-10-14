import type {
  ThreadHeaderControlsProps,
  useThreadRightHeaderItems as useIosThreadRightHeaderItems,
} from "./ThreadHeaderControls";

export type { ThreadHeaderControlsProps } from "./ThreadHeaderControls";

const EMPTY_HEADER_ITEMS: ReturnType<typeof useIosThreadRightHeaderItems> = [];

/** Android renders these controls as ScreenHeader actions in ThreadHeader. */
export function useThreadRightHeaderItems(_props: ThreadHeaderControlsProps) {
  return EMPTY_HEADER_ITEMS;
}

export function useThreadCenterHeaderItems(_props: ThreadHeaderControlsProps) {
  return EMPTY_HEADER_ITEMS;
}

export function ThreadHeaderControls(_props: ThreadHeaderControlsProps) {
  return null;
}
