import type { Icon } from "../Icons";

export const FinderIcon: Icon = (props) => (
  <svg viewBox="0 0 24 24" fill="none" {...props}>
    <rect x="2" y="2" width="20" height="20" rx="4" fill="#36A9F5" />
    <path
      d="M13 2h5a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4h-6c-1-4-1-7 0-10H9c0-4 2-8 4-10Z"
      fill="#D9F1FF"
    />
    <path
      d="M7 7v2m10-2v2M6 15c3 3 9 3 12 0"
      stroke="#163A59"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

export const FileExplorerIcon: Icon = (props) => (
  <svg viewBox="0 0 24 24" fill="none" {...props}>
    <path
      d="M2 5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z"
      fill="#D99A16"
    />
    <path d="M2 9h20v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z" fill="#FFCE45" />
    <path d="M8 14h8v7H8Z" fill="#58B8E8" />
    <path d="M10 16h4v2h-4Z" fill="#1879B9" />
  </svg>
);
