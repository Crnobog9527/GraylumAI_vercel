/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/* Disposable local fixture only. Never loaded into a remote database. */
#include "postgres.h"
#include "fmgr.h"
#include "miscadmin.h"
#include "access/xact.h"
#include "executor/spi.h"
#include "postmaster/bgworker.h"
#include "storage/ipc.h"
#include "tcop/tcopprot.h"
#include "utils/snapmgr.h"
#include "utils/guc.h"
#include <unistd.h>
PG_MODULE_MAGIC;
PGDLLEXPORT void b1b_proof_main(Datum arg);
PG_FUNCTION_INFO_V1(b1b_proof_launch);
Datum b1b_proof_launch(PG_FUNCTION_ARGS) {
  BackgroundWorker worker = {0};
  BackgroundWorkerHandle *handle;
  pid_t pid;
  worker.bgw_flags = BGWORKER_SHMEM_ACCESS | BGWORKER_BACKEND_DATABASE_CONNECTION;
  worker.bgw_start_time = BgWorkerStart_RecoveryFinished;
  worker.bgw_restart_time = BGW_NEVER_RESTART;
  snprintf(worker.bgw_library_name, BGW_MAXLEN, "b1b_worker_proof");
  snprintf(worker.bgw_function_name, BGW_MAXLEN, "b1b_proof_main");
  snprintf(worker.bgw_name, BGW_MAXLEN, "b1b proof worker");
  snprintf(worker.bgw_type, BGW_MAXLEN, "b1b proof worker");
  worker.bgw_notify_pid = MyProcPid;
  worker.bgw_main_arg = BoolGetDatum(PG_GETARG_BOOL(0));
  if (!RegisterDynamicBackgroundWorker(&worker, &handle)) elog(ERROR, "worker registration failed");
  if (WaitForBackgroundWorkerStartup(handle, &pid) != BGWH_STARTED) elog(ERROR, "worker start failed");
  PG_RETURN_INT32(pid);
}
static void marker(const char *path) {
  FILE *f = fopen(path, "w");
  if (!f) elog(ERROR, "marker creation failed");
  fclose(f);
}
PGDLLEXPORT void b1b_proof_main(Datum arg) {
  bool isnull, active;
  pqsignal(SIGTERM, die);
  BackgroundWorkerUnblockSignals();
  BackgroundWorkerInitializeConnection("dbb", NULL, 0);
  if (DatumGetBool(arg)) SetConfigOption("track_activities", "off", PGC_SUSET, PGC_S_SESSION);
  StartTransactionCommand();
  PushActiveSnapshot(GetTransactionSnapshot());
  SPI_connect();
  if (SPI_execute("SELECT p.status='active' AND p.is_deleted='false' FROM profiles p "
      "JOIN b1b_worker_fixture f ON f.actor=p.id", true, 1) != SPI_OK_SELECT || SPI_processed != 1)
    elog(ERROR, "active check failed");
  active = DatumGetBool(SPI_getbinval(SPI_tuptable->vals[0], SPI_tuptable->tupdesc, 1, &isnull));
  SPI_finish();
  PopActiveSnapshot();
  /* A legal READ COMMITTED statement gap: no read snapshot, still in the transaction. */
  InvalidateCatalogSnapshot();
  marker("/tmp/b1b-proof-ready");
  while (access("/tmp/b1b-proof-resume", F_OK) != 0) {
    pg_usleep(100000L);
    CHECK_FOR_INTERRUPTS();
  }
  PushActiveSnapshot(GetTransactionSnapshot());
  SPI_connect();
  if (active) {
    if (SPI_execute("INSERT INTO agent_confirmed_preferences(actor_id,scope_key,name,value,version,active,source) "
        "SELECT actor,'user','worker','late private preference',1,true,'explicit_user_confirmation' "
        "FROM b1b_worker_fixture", false, 0) != SPI_OK_INSERT) elog(ERROR, "late preference write failed");
    if (SPI_execute("INSERT INTO runtime_sessions(actor_id,scope,start_request_id,start_payload) "
        "SELECT actor,'{\"kind\":\"worker_test\"}',gen_random_uuid(),'{\"private\":\"late body\"}' "
        "FROM b1b_worker_fixture", false, 0) != SPI_OK_INSERT) elog(ERROR, "late runtime write failed");
  }
  SPI_finish();
  PopActiveSnapshot();
  CommitTransactionCommand();
  marker("/tmp/b1b-proof-finished");
  while (access("/tmp/b1b-proof-exit", F_OK) != 0) {
    pg_usleep(100000L);
    CHECK_FOR_INTERRUPTS();
  }
  proc_exit(0);
}
