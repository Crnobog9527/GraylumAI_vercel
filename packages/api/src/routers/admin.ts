import { router } from '../trpc';
import { adminRefundProcedures } from './adminRefunds';
import { membershipPlanMutations } from './adminMembershipPlans';
import { adminDashboardProcedures } from './adminDashboardStats';
import { adminUserProcedures } from './adminUsers';
import { adminUserMembershipProcedures } from './adminUserMembership';
import { adminTicketProcedures } from './adminTickets';
import { adminTransactionProcedures } from './adminTransactions';
import { adminPackageProcedures } from './adminPackages';
import { adminAnnouncementProcedures } from './adminAnnouncements';
import { adminModuleProcedures } from './adminModules';
import { adminFinanceProcedures } from './adminFinanceStats';
import { adminSettingsDashboardProcedures } from './adminSettingsDashboard';
import { adminSignupGuardProcedures } from './adminSignupGuard';
import { adminPerformanceProcedures } from './adminPerformanceStats';

// The admin router: every procedure lives in a sibling ./admin*.ts file, grouped by back-office area, and is spread in here,
// so its path is still `admin.<name>`. Keep this file to the list.
export const adminRouter = router({
  ...adminRefundProcedures,
  ...adminDashboardProcedures,
  ...adminUserProcedures,
  ...adminUserMembershipProcedures,
  ...adminTicketProcedures,
  ...adminTransactionProcedures,
  ...adminPackageProcedures,
  ...adminAnnouncementProcedures,
  ...adminModuleProcedures,
  ...adminFinanceProcedures,
  ...adminSettingsDashboardProcedures,
  ...adminSignupGuardProcedures,
  ...membershipPlanMutations,
  ...adminPerformanceProcedures,
});
