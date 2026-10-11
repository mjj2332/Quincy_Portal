/** The one path the guest review page owns (#741 12b). Exact: `/d/review/` and `/d/reviews` are the Worker's stub, not this page. */
export const isGuestReviewPath = (pathname: string): boolean => pathname === "/d/review";
