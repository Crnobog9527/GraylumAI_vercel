/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export async function verifyPdf(admin, one, two) {
  const a=randomUUID(),b=randomUUID();
  await admin.query('INSERT INTO profiles(id) VALUES($1),($2)',[a,b]);
  const value=async(c,q,args=[]) => (await c.query(q,args)).rows[0].v;
  const begin=(c,actor,r=randomUUID())=>value(c,"SELECT library_upload_begin($1,$2,'scan.pdf','pdf','reference',5) v",[actor,r]);
  await admin.query("UPDATE system_settings SET value='false' WHERE key='library_upload_enabled'");
  await assert.rejects(begin(one,a),/LIBRARY_DISABLED/);
  await admin.query("UPDATE system_settings SET value='true' WHERE key='library_upload_enabled'");
  await admin.query("UPDATE membership_plans SET library_storage_bytes=30000000 WHERE level='free'");
  const barrier=async(promises,pattern)=>{
    let blocked=false;
    for(let i=0;i<500;i++) {
      await admin.query('SELECT pg_stat_clear_snapshot()');
      const n=await value(admin,"SELECT count(*)::int v FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1",[pattern]);
      if(n===2){blocked=true;break;}
      await new Promise(r=>setTimeout(r,10));
    }
    assert.ok(blocked,'both connections reached the real profile lock');
    await admin.query('COMMIT');
    return Promise.allSettled(promises);
  };
  await admin.query('BEGIN');await admin.query('SELECT id FROM profiles WHERE id=$1 FOR UPDATE',[a]);
  const admitted=await barrier([begin(one,a),begin(two,a)],'SELECT library_upload_begin%');
  assert.equal(admitted.filter(x=>x.status==='fulfilled').length,1);
  assert.match(admitted.find(x=>x.status==='rejected').reason.message,/LIBRARY_SPACE/);
  const did=admitted.find(x=>x.status==='fulfilled').value.documentId;
  assert.equal(await value(admin,'SELECT library_usage($1) v',[a]),'20000000');
  const grant=(c,actor=a)=>value(c,'SELECT library_pdf_text_begin($1,$2,5) v',[actor,did]);
  await assert.rejects(grant(one,b),/LIBRARY_NOT_FOUND/);
  await admin.query('BEGIN');await admin.query('SELECT id FROM profiles WHERE id=$1 FOR UPDATE',[a]);
  const grants=await barrier([grant(one),grant(two)],'SELECT library_pdf_text_begin%');
  assert.equal(grants.filter(x=>x.status==='fulfilled' && x.value.dispatch).length,1);
  assert.equal(grants.filter(x=>x.status==='fulfilled' && !x.value.dispatch).length,1);
  const segments=[{title:'第 1 页',body:'hello',page_number:1}];
  const pages=['text','scanned','blank'].map((status,i)=>({page_number:i+1,status}));
  const publish=(actor=a,ss=segments,ps=pages,bytes=7)=>value(one,'SELECT library_pdf_publish($1,$2,5,$3,$4,$5) v',
    [actor,did,bytes,JSON.stringify(ss),JSON.stringify(ps)]);
  await assert.rejects(publish(b),/LIBRARY_NOT_FOUND/);
  await assert.rejects(publish(a,[{...segments[0],page_number:2}]),/LIBRARY_PAGES/);
  await assert.rejects(publish(a,segments,[{page_number:1,status:'text'},{page_number:3,status:'blank'}]),/LIBRARY_PAGES/);
  await assert.rejects(publish(a,segments,pages,5),/LIBRARY_PAGES/);
  assert.equal(await value(admin,'SELECT count(*)::int v FROM library_recognition_units WHERE document_id=$1',[did]),0);
  await admin.query("UPDATE membership_plans SET library_storage_bytes=20000000 WHERE level='free'");
  await assert.rejects(publish(),/LIBRARY_SPACE/);
  await admin.query("UPDATE membership_plans SET library_storage_bytes=30000000 WHERE level='free'");
  // Force a failure after the existing publisher to prove atomic rollback of content, status and accounting.
  await admin.query(`CREATE FUNCTION public.pdf_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'PDF_TEST_ROLLBACK'; END $$;
    CREATE TRIGGER pdf_test_fail BEFORE INSERT ON library_recognition_units FOR EACH ROW EXECUTE FUNCTION pdf_test_fail()`);
  await assert.rejects(publish(),/PDF_TEST_ROLLBACK/);
  assert.equal(await value(admin,'SELECT count(*)::int v FROM library_document_segments WHERE document_id=$1',[did]),0);
  assert.equal(await value(admin,'SELECT status v FROM library_documents WHERE id=$1',[did]),'uploading');
  assert.equal(await value(admin,'SELECT library_usage($1) v',[a]),'20000000');
  await admin.query('DROP TRIGGER pdf_test_fail ON library_recognition_units; DROP FUNCTION public.pdf_test_fail()');
  assert.equal((await publish()).status,'ready');
  assert.equal((await publish()).status,'ready');
  assert.equal(await value(admin,'SELECT library_usage($1) v',[a]),'20000005');
  assert.deepEqual((await admin.query('SELECT position,has_text,status FROM library_recognition_units WHERE document_id=$1 ORDER BY position',[did])).rows,
    [{position:1,has_text:true,status:'complete'},{position:2,has_text:false,status:'pending'},{position:3,has_text:false,status:'complete'}]);
  assert.equal(await value(admin,'SELECT text_bytes v FROM library_documents WHERE id=$1',[did]),'7');
  const read=await value(one,'SELECT library_segments_range($1,$2,1,0,50) v',[a,did]);
  assert.equal(read[0].page_number,1);assert.equal(read[0].source,'extracted');
  await assert.rejects(one.query('SELECT library_segments_range($1,$2,1)',[b,did]),/LIBRARY_NOT_FOUND/);
  await admin.query("UPDATE library_upload_reservations SET original_guard_until=now()-interval '1 minute',text_guard_until=now()-interval '1 minute' WHERE document_id=$1",[did]);
  await value(one,'SELECT library_cleanup_observe($1,$2,false) v',[a,did]);
  assert.equal(await value(admin,'SELECT library_usage($1) v',[a]),'17','original 5 + text object 7 + segments 5');
  await value(one,'SELECT library_delete($1,$2) v',[a,did]);
  assert.equal(await value(admin,'SELECT count(*)::int v FROM library_recognition_units WHERE document_id=$1',[did]),0);
  await assert.rejects(one.query('SELECT library_document_read($1,$2)',[a,did]),/LIBRARY_NOT_FOUND/);
  await value(one,'SELECT library_cleanup_observe($1,$2,true) v',[a,did]);
  await new Promise(r=>setTimeout(r,1050));
  assert.equal(await value(one,'SELECT library_cleanup_observe($1,$2,true) v',[a,did]),true);
  assert.equal(await value(admin,'SELECT library_usage($1) v',[a]),'0');
  const empty=(await begin(one,a)).documentId;
  await one.query('SELECT library_pdf_text_begin($1,$2,5)',[a,empty]);
  await one.query("SELECT library_pdf_publish($1,$2,5,0,'[]',$3)",[a,empty,JSON.stringify([{page_number:1,status:'scanned'}])]);
  assert.equal(await value(admin,'SELECT count(*)::int v FROM library_document_segments WHERE document_id=$1',[empty]),0);
  assert.equal(await value(admin,'SELECT status v FROM library_recognition_units WHERE document_id=$1',[empty]),'pending');
  for(const role of ['anon','authenticated']) {
    await admin.query('SET ROLE '+role);
    await assert.rejects(admin.query('SELECT public.library_pdf_text_begin($1,$2,5)',[a,empty]),/permission denied/);
    await assert.rejects(admin.query("SELECT public.library_pdf_publish($1,$2,5,0,'[]','[]')",[a,empty]),/permission denied/);
    await admin.query('RESET ROLE');
  }
  console.log('PASS: PDF grants/quota barriers, metadata, atomic rollback, page units, empty scan, dual holds, deletion, denied roles');
}
