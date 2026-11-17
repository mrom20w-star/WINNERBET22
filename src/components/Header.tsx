interface HeaderProps {
  balance: number;
  unreadCount: number;
  onOpenDeposit: () => void;
  onOpenNotifications: () => void;
  onBack: () => void;
}

export function Header({
  balance,
  unreadCount,
  onOpenDeposit,
  onOpenNotifications,
  onBack,
}: HeaderProps) {
  const formattedBalance = Number.isInteger(balance)
    ? balance.toString()
    : balance.toFixed(2);

  return (
    <div
      className="sticky top-0 z-40 w-full bg-[#212328] border-b border-white/[0.07] shadow-[0_2px_8px_rgba(0,0,0,0.32)]"
      dir="rtl"
    >
      <header className="flex h-[52px] w-full items-center justify-between px-3.5 md:h-[56px] md:px-6">
        {/* Right side (RTL start): back arrow */}
        <button
          type="button"
          aria-label="رجوع"
          onClick={onBack}
          className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#b3b7bf] transition-colors hover:bg-white/5 hover:text-white active:opacity-60"
        >
          <svg
            width="23"
            height="23"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="4" y1="12" x2="20" y2="12" />
            <polyline points="13 5 20 12 13 19" />
          </svg>
        </button>

        {/* Center: gray wallet capsule (#9E9E9E outer + #4D4D4D inner balance pill) + uploaded orange + image */}
        <button
          type="button"
          aria-label="إيداع"
          onClick={onOpenDeposit}
          className="inline-flex max-w-[74vw] cursor-pointer items-center gap-[6px] rounded-full bg-[#9E9E9E] px-[5px] py-[4px] ring-1 ring-[#848484] shadow-[0_1px_4px_rgba(0,0,0,0.3)] transition-transform active:scale-[0.98]"
        >
          <span
            dir="ltr"
            className="flex h-[28px] min-w-[96px] items-center justify-center rounded-full bg-[#4D4D4D] px-3.5 text-[14px] font-semibold leading-none tracking-[0.01em] text-white tabular-nums whitespace-nowrap"
          >
            {formattedBalance} ج.م
          </span>

          <span
            className="relative flex h-[28px] w-[36px] shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-[#da3e01]"
            aria-hidden="true"
          >
            <img
              src="/assets/aistudio/photo_2026-11-17_15-46-55_38f0c1a1.jpg"
              alt=""
              draggable={false}
              className="h-full w-full scale-[1.18] object-cover select-none"
            />
          </span>
        </button>

        {/* Left side (RTL end): BONUS + rosette seal */}
        <button
          type="button"
          aria-label="المكافآت والإشعارات"
          onClick={onOpenNotifications}
          className="relative flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-[#b3b7bf] transition-colors hover:bg-white/5 hover:text-white active:opacity-60"
        >
          <svg
            width="30"
            height="30"
            viewBox="0 0 34 34"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M17 2.8l1.9 1.7 2.5-.8 1.2 2.3 2.6.2.3 2.6 2.4 1.1-.6 2.5 1.8 1.9-1.4 2.2 1 2.4-2.1 1.5.1 2.6-2.5.7-.7 2.5-2.6-.2-1.6 2-2.3-1-2.2 1.3-1.8-1.9-2.5.4-1-2.4-2.5-.4-.1-2.6-2.2-1.3.8-2.5-1.5-2 1.7-2-.7-2.5 2.3-1.2.2-2.6 2.6-.3 1.1-2.4 2.5.6L17 2.8z"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinejoin="round"
              fill="#212328"
            />
            <text
              x="17"
              y="18.8"
              textAnchor="middle"
              fill="currentColor"
              fontSize="5.2"
              fontWeight="800"
              fontFamily="Roboto, Arial, sans-serif"
              letterSpacing="0.25"
            >
              BONUS
            </text>
            <circle
              cx="25.6"
              cy="25.6"
              r="4.7"
              fill="currentColor"
              stroke="#212328"
              strokeWidth="1.3"
            />
            <path
              d="M25.6 23.4v4.4M23.4 25.6h4.4"
              stroke="#212328"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
          {unreadCount > 0 && (
            <span className="absolute end-1.5 top-1.5 h-2 w-2 rounded-full bg-[#ff6a00] ring-2 ring-[#212328]" />
          )}
        </button>
      </header>
    </div>
  );
}
