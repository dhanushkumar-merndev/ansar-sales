-- Demo data (~1,000 records) for trying the CRM, its timelines and reports.
-- Everything is created by the demo_* users (inactive, never able to sign in), so it can be removed exactly
-- with demo-clean.sql. Run through scripts/seed-demo.mjs, which creates those users first.
--
-- Triggers are off for this session so timestamps can be spread over the past ~14 months and no Telegram
-- reminders are queued; the activity history that triggers would write is written here explicitly.
-- With triggers off, foreign keys are not checked either: every reference below comes from rows inserted here.

set session_replication_role = replica;

do $$
declare
  s1 uuid; s2 uuid; s3 uuid; s4 uuid; acc uuid;
  sales uuid[];
  sales_names text[];
  today date := (now() at time zone 'Asia/Kolkata')::date;
  first_names text[] := array['Aarav','Priya','Rahul','Ananya','Vikram','Sneha','Arjun','Kavya','Rohan','Meera','Karthik','Divya',
    'Sanjay','Lakshmi','Imran','Fatima','Joseph','Mary','Harpreet','Gurpreet','Naveen','Pooja','Suresh','Anjali','Mohammed','Ayesha',
    'Rajesh','Deepa','Vijay','Nisha','Ganesh','Swathi','Abdul','Zara','Kiran','Ritu','Manoj','Shalini','Prakash','Bhavna'];
  last_names text[] := array['Sharma','Iyer','Reddy','Khan','Nair','Patel','Gupta','Menon','Singh','Das','Pillai','Rao','Joshi',
    'Fernandes','Shaikh','Mehta','Chopra','Bose','Kulkarni','Varghese','Hegde','Ansari','Mishra','Banerjee'];
  companies text[] := array['Traders','Enterprises','Clinic','Studio','Foods','Textiles','Motors','Academy','Interiors','Pharma',
    'Realty','Logistics','Salon','Bakery','Fitness','Jewellers','Tech','Exports','Hotels','Opticals'];
  niche_names text[] := array['Demo Dental Clinics','Demo Real Estate','Demo Restaurants','Demo Gyms & Fitness','Demo Schools',
    'Demo Salons','Demo Retail Shops','Demo IT Services','Demo Hospitals','Demo Jewellery','Demo 100% Organic_Farms',
    'Demo Café & Bakery ☕'];
  niche_ids uuid[] := '{}';
  n_archived uuid := gen_random_uuid();
  n_merged uuid := gen_random_uuid();
  note_bodies text[] := array[
    'Called, asked to send the brochure on WhatsApp.',
    'Interested in the premium plan. Wants a demo next week.',
    'Budget is tight this quarter; follow up after Diwali.',
    'Spoke to the owner. Decision maker is the partner, not him.',
    E'Meeting notes:\n- needs 3 branches covered\n- wants monthly billing\n- asked about GST invoice',
    'பேசினோம், அடுத்த வாரம் மீண்டும் அழைக்கவும்.',
    'बात हुई, अगले हफ्ते दोबारा कॉल करें।',
    'Sent quotation #Q-2291 for ₹48,500 + GST.',
    'Wrong number given at the expo; found the right one on Google Maps.',
    'Prefers calls after 6 PM. 😊',
    '<b>Not bold</b> & <script>alert("x")</script> should show as plain text.',
    'Asked for 10% discount; told him max 5%.'];
  long_note text := repeat('Long note to check wrapping and the 5,000 character limit. ', 80);
  call_outcomes text[] := array['connected','no_answer','busy','wrong_number','connected','connected'];
  stages public.lead_status[] := array['new','contacted','interested','proposal_sent','won']::public.lead_status[];
  edge_names text[] := array[
    'A',
    'Sri Lakshmi Venkateswara Textiles and Readymade Garments Wholesale and Retail Showroom Private Limited, Chennai South 12',
    'முருகன் ஸ்டோர்ஸ்', 'राम ट्रेडर्स', 'Café ☕ Bloom', 'O''Brien & Sons', '100% Pure_Oils', '<script>alert(1)</script>',
    'Dr. K. R. Ramaswamy (MBBS, MD)', 'ALL CAPS ENTERPRISES', 'lowercase traders', 'Name   With   Spaces Inside',
    'Duplicate Phone Lead (1 of 2)', 'Duplicate Phone Lead (2 of 2)', 'International Lead – Dubai'];
  edge_phones text[] := array['+919000000001','+919876543210','+919444012345','+919811198111','+919845012345','+447700900123',
    '+6591234567','+12025550143','+919000000013','+919000000014','+919000000015','+919000000016','+919555500055',
    '+919555500055','+971501234567'];
  i integer; k integer; j integer;
  r double precision;
  v_lead uuid; v_owner uuid; v_creator uuid; v_status public.lead_status; v_niche uuid;
  v_created timestamptz; v_t timestamptz; v_name text; v_phone text; v_email text;
  v_path public.lead_status[]; v_archived boolean; v_reassign boolean; v_version integer; v_prev uuid;
  v_fu uuid; v_due timestamptz; v_state public.follow_up_state; v_done timestamptz; v_task text;
  tasks text[] := array['Call back about pricing','Send brochure on WhatsApp','Demo at their office','Collect signed proposal',
    'Check if payment is done','Visit store with samples','Share case study PDF','Confirm meeting time','Follow up after festival',
    'Ask for referral'];
  v_date date; v_amount numeric; v_cat public.expense_category; v_mode text; v_item text; v_qty integer; v_exp uuid;
  modes text[] := array['upi','upi','upi','bank_transfer','bank_transfer','cash','card','cheque','other'];
  v_rec uuid;
begin
  select id into s1 from public.profiles where username = 'demo_sales_1';
  select id into s2 from public.profiles where username = 'demo_sales_2';
  select id into s3 from public.profiles where username = 'demo_sales_3';
  select id into s4 from public.profiles where username = 'demo_sales_4';
  select id into acc from public.profiles where username = 'demo_account';
  if s1 is null or s2 is null or s3 is null or s4 is null or acc is null then
    raise exception 'demo users missing: run scripts/seed-demo.mjs, which creates them first';
  end if;
  sales := array[s1, s2, s3, s4];
  select array_agg(display_name order by array_position(sales, id)) into sales_names from public.profiles where id = any(sales);
  if exists (select 1 from public.leads where created_by = any(sales))
     or exists (select 1 from public.expenses where created_by = acc)
     or exists (select 1 from public.niches where name like 'Demo %') then
    raise exception 'demo data already present: run the seed with --clean first';
  end if;
  perform setseed(0.4242);

  -- Niches: active ones, one archived (still used by old leads), one merged into another (no leads left).
  for i in 1 .. array_length(niche_names, 1) loop
    niche_ids := niche_ids || gen_random_uuid();
    insert into public.niches (id, name, created_by, created_at, updated_at)
    values (niche_ids[i], niche_names[i], sales[1 + (i % 3)], now() - interval '430 days', now() - interval '430 days');
  end loop;
  insert into public.niches (id, name, created_by, created_at, updated_at, archived_at)
  values (n_archived, 'Demo Archived – Travel Agents', s1, now() - interval '400 days', now() - interval '60 days', now() - interval '60 days');
  insert into public.niches (id, name, created_by, created_at, updated_at, merged_into_id, archived_at)
  values (n_merged, 'Demo dentists (old name)', s2, now() - interval '400 days', now() - interval '90 days', niche_ids[1], now() - interval '90 days');

  -- 600 leads: 15 edge cases first, then generated ones; spread over ~14 months, newer ones more frequent.
  for i in 1 .. 600 loop
    r := random();
    v_owner := case when r < 0.33 then s1 when r < 0.62 then s2 when r < 0.90 then s3 else s4 end;
    v_creator := v_owner;
    v_reassign := random() < 0.08;
    if v_reassign then
      v_creator := sales[1 + floor(random() * 3)::int];
      if v_creator = v_owner then v_creator := case when v_owner = s1 then s2 else s1 end; end if;
    end if;
    v_created := now() - (power(random(), 1.7) * 420) * interval '1 day' - random() * interval '9 hours';
    if i <= array_length(edge_names, 1) then
      v_name := edge_names[i];
      v_phone := edge_phones[i];
      v_created := now() - (i * 3) * interval '1 day';
    else
      v_name := first_names[1 + floor(random() * array_length(first_names, 1))::int] || ' ' ||
                last_names[1 + floor(random() * array_length(last_names, 1))::int] ||
                case when random() < 0.45 then ' ' || companies[1 + floor(random() * array_length(companies, 1))::int] else '' end;
      v_phone := '+91' || (6000000000 + floor(random() * 3999999999))::bigint;
    end if;
    v_email := case when random() < 0.55
      then lower(regexp_replace(split_part(v_name, ' ', 1), '[^A-Za-z]', '', 'g')) || i ||
           (array['@example.com','@example.in','@EXAMPLE.ORG','@mail.example.co.in'])[1 + floor(random() * 4)::int]
      else null end;
    if v_email ~ '^[0-9]' then v_email := 'lead' || v_email; end if;
    v_niche := case when random() < 0.04 then n_archived else niche_ids[1 + floor(power(random(), 1.3) * array_length(niche_ids, 1))::int] end;

    r := random();
    k := case when r < 0.24 then 1 when r < 0.43 then 2 when r < 0.58 then 3 when r < 0.68 then 4 when r < 0.84 then 5 else -1 end;
    if k = -1 then
      v_path := stages[1 : 1 + floor(random() * 4)::int] || array['lost']::public.lead_status[];
    else
      v_path := stages[1 : k];
    end if;
    v_status := v_path[array_length(v_path, 1)];
    v_archived := random() < 0.03 or (v_status = 'lost' and random() < 0.15);
    v_lead := gen_random_uuid();
    v_version := array_length(v_path, 1) + case when v_reassign then 1 else 0 end;

    insert into public.leads (id, name, phone, phone_normalized, email, niche_id, status, owner_id, created_by, version, created_at, updated_at)
    values (v_lead, v_name,
      case when i % 7 = 0 and v_phone like '+91%' then '+91 ' || substr(v_phone, 4, 5) || '-' || substr(v_phone, 9) else v_phone end,
      v_phone, v_email, v_niche, v_status, v_owner, v_creator, v_version, v_created, v_created);

    insert into public.lead_activities (lead_id, actor_id, type, meta, created_at)
    values (v_lead, v_creator, 'lead_created', jsonb_build_object('status', 'new',
      'owner', sales_names[array_position(sales, v_creator)],
      'niche', (select name from public.niches where id = v_niche)), v_created);

    v_t := v_created;
    if v_reassign then
      v_t := v_t + least((now() - v_t) * 0.2, (random() * 3 + 0.1) * interval '1 day');
      insert into public.lead_activities (lead_id, actor_id, type, meta, created_at)
      values (v_lead, null, 'assigned', jsonb_build_object('from', sales_names[array_position(sales, v_creator)],
        'to', sales_names[array_position(sales, v_owner)]), v_t);
    end if;

    for j in 2 .. coalesce(array_length(v_path, 1), 1) loop
      v_t := v_t + least((now() - v_t) * (0.15 + random() * 0.3), (random() * 8 + 0.05) * interval '1 day');
      insert into public.lead_activities (lead_id, actor_id, type, meta, created_at)
      values (v_lead, v_owner, 'status_changed', jsonb_build_object('from', v_path[j - 1], 'to', v_path[j]), v_t);
    end loop;

    for j in 1 .. floor(random() * 4)::int loop
      insert into public.lead_activities (lead_id, actor_id, type, body, created_at)
      values (v_lead, v_owner, 'note',
        case when i = 20 and j = 1 then long_note else note_bodies[1 + floor(random() * array_length(note_bodies, 1))::int] end,
        v_created + random() * (now() - v_created));
    end loop;

    for j in 1 .. floor(random() * 3)::int loop
      insert into public.lead_activities (lead_id, actor_id, type, meta, body, created_at)
      values (v_lead, v_owner, 'call_logged',
        jsonb_build_object('phone', v_phone, 'outcome', call_outcomes[1 + floor(random() * array_length(call_outcomes, 1))::int]),
        case when random() < 0.3 then 'Said to call back tomorrow.' else null end,
        v_created + random() * (now() - v_created));
    end loop;

    if v_archived then
      v_t := v_t + least((now() - v_t) * 0.5, random() * interval '5 days');
      update public.leads set archived_at = v_t, archived_by = null, updated_at = v_t, version = version + 1 where id = v_lead;
      insert into public.lead_activities (lead_id, actor_id, type, created_at) values (v_lead, null, 'lead_archived', v_t);
    else
      update public.leads set updated_at = v_t where id = v_lead;
    end if;
  end loop;

  -- 250 follow-ups on active leads: overdue, due today (IST), upcoming, completed on time / late, cancelled, rescheduled.
  i := 0;
  for v_lead, v_owner, v_created in
    select l.id, l.owner_id, l.created_at from public.leads l
    where l.created_by = any(sales) and l.archived_at is null
    order by md5(l.id::text) limit 250
  loop
    i := i + 1;
    v_fu := gen_random_uuid();
    v_task := tasks[1 + (i % array_length(tasks, 1))];
    k := i % 10;
    v_state := 'pending'; v_done := null;
    if k in (0, 1) then                       -- overdue (1 hour to 20 days ago)
      v_due := now() - (random() * 20 + 0.04) * interval '1 day';
    elsif k = 2 then                          -- due today in IST, morning to evening
      v_due := (today::timestamp + make_interval(hours => 9 + (i % 11))) at time zone 'Asia/Kolkata';
    elsif k in (3, 4, 5) then                 -- upcoming (next 30 days)
      v_due := now() + (random() * 30 + 0.02) * interval '1 day';
    elsif k in (6, 7) then                    -- completed (some on time, some late)
      v_due := greatest(v_created + interval '1 hour', now() - (random() * 120 + 1) * interval '1 day');
      v_state := 'completed';
      v_done := least(now() - interval '1 minute', v_due + case when k = 6 then -random() * interval '20 hours' else (random() * 4 + 0.1) * interval '1 day' end);
      v_done := greatest(v_done, v_created + interval '30 minutes');
    else                                      -- cancelled
      v_due := greatest(v_created + interval '1 hour', now() - (random() * 60 - 10) * interval '1 day');
      v_state := 'cancelled';
      v_done := least(now() - interval '1 minute', greatest(v_created + interval '30 minutes', v_due - random() * interval '2 days'));
    end if;
    v_t := greatest(v_created, least(coalesce(v_done, now()), v_due) - (random() * 6 + 0.1) * interval '1 day');

    insert into public.follow_ups (id, lead_id, assignee_id, task, due_at, state, outcome, revision, created_by,
      completed_at, completed_by, cancelled_at, created_at, updated_at)
    values (v_fu, v_lead, v_owner, v_task, v_due, v_state,
      case when v_state = 'completed' then (array['Agreed to a demo','Not interested right now','Paid advance','Asked for a revised quote'])[1 + i % 4] end,
      case when i % 9 = 0 then 2 else 1 end, v_owner,
      case when v_state = 'completed' then v_done end, case when v_state = 'completed' then v_owner end,
      case when v_state = 'cancelled' then v_done end, v_t, coalesce(v_done, v_t));

    insert into public.lead_activities (lead_id, actor_id, type, follow_up_id, meta, created_at)
    values (v_lead, v_owner, 'follow_up_scheduled', v_fu,
      jsonb_build_object('task', v_task, 'due_at', case when i % 9 = 0 then v_due - interval '2 days' else v_due end), v_t);
    if i % 9 = 0 then
      insert into public.lead_activities (lead_id, actor_id, type, follow_up_id, meta, created_at)
      values (v_lead, v_owner, 'follow_up_rescheduled', v_fu,
        jsonb_build_object('task', v_task, 'from', v_due - interval '2 days', 'to', v_due), v_t + interval '3 hours');
    end if;
    if v_state <> 'pending' then
      insert into public.lead_activities (lead_id, actor_id, type, follow_up_id, body, meta, created_at)
      values (v_lead, v_owner, case when v_state = 'completed' then 'follow_up_completed' else 'follow_up_cancelled' end::public.lead_activity_type,
        v_fu, (select outcome from public.follow_ups where id = v_fu), jsonb_build_object('task', v_task, 'due_at', v_due), v_done);
    end if;
  end loop;

  -- Expenses: 14 months of rent, salaries, subscriptions (items with seats), marketing, utilities and small purchases.
  -- Monthly series are recorded as stopped so the hourly job never adds demo rows or sends Telegram messages.
  for i in 0 .. 13 loop
    v_date := (date_trunc('month', today) - make_interval(months => i))::date;
    -- rent on the 1st, salaries on the last day, Canva and ChatGPT subscriptions
    for k in 1 .. 4 loop
      v_cat := (array['rent','salary','software','software'])[k]::public.expense_category;
      v_amount := (array[25000, 42000, 499, 1999])[k];
      v_item := (array[null, null, 'Canva', 'ChatGPT Plus'])[k];
      v_qty := (array[null, 2, case when i < 6 then 3 else 2 end, 1])[k];
      if k = 2 then v_item := 'Staff salary'; v_amount := 21000 * v_qty; end if;
      v_mode := case when i > 10 then null else (array['bank_transfer','bank_transfer','card','card'])[k] end;
      continue when (case when k = 2 then (v_date + interval '1 month - 1 day')::date else v_date + (array[0, 0, 4, 14])[k] end) > today;
      insert into public.expenses (expense_date, category, amount, payment_mode, item, quantity, description, created_by, created_at, updated_at)
      values (case when k = 2 then (v_date + interval '1 month - 1 day')::date else v_date + (array[0, 0, 4, 14])[k] end,
        v_cat, v_amount, v_mode, v_item, v_qty,
        (array['Office rent', 'Two sales staff', 'Design tool seats', 'AI assistant'])[k], acc,
        v_date::timestamp + interval '10 hours', v_date::timestamp + interval '10 hours');
    end loop;
    -- variable marketing, utilities and miscellaneous items
    for k in 1 .. 4 + floor(random() * 4)::int loop
      v_cat := (array['marketing','utilities','miscellaneous','marketing','miscellaneous','utilities','software'])[k]::public.expense_category;
      v_item := (array['Instagram ads','Electricity bill','Printer paper (A4 rims)','Google Ads','Tea & snacks','Internet','Figma'])[k];
      v_qty := (array[null, null, 2 + floor(random() * 8)::int, null, null, null, 1])[k];
      v_amount := round(((array[8000, 3200, 250, 6000, 1200, 1499, 1050])[k] * (0.6 + random() * 0.9))::numeric, 2);
      insert into public.expenses (expense_date, category, amount, payment_mode, item, quantity, created_by, created_at, updated_at)
      values (least(today, v_date + floor(random() * 27)::int), v_cat, v_amount, modes[1 + floor(random() * array_length(modes, 1))::int],
        v_item, v_qty, acc, v_date::timestamp + interval '12 hours', v_date::timestamp + interval '12 hours');
    end loop;
  end loop;
  -- edge cases: one paisa, a huge archived amount, a long description, a unicode item, an archived entry
  insert into public.expenses (expense_date, category, amount, payment_mode, item, quantity, description, created_by, archived_at, created_at, updated_at) values
    (today - 3, 'miscellaneous', 0.01, 'upi', 'Rounding test', 1, 'Smallest possible amount', acc, null, now() - interval '3 days', now() - interval '3 days'),
    (today - 40, 'miscellaneous', 999999999999.99, 'other', null, null, 'Archived: largest possible amount (should never count in totals)', acc, now() - interval '39 days', now() - interval '40 days', now() - interval '39 days'),
    (today - 12, 'marketing', 15750.50, 'cheque', 'Flex banners', 25, repeat('Long description for wrapping checks. ', 13), acc, null, now() - interval '12 days', now() - interval '12 days'),
    (today - 8, 'miscellaneous', 640, 'cash', 'பூஜை பொருட்கள் (Pooja items)', 1, 'Unicode item name', acc, null, now() - interval '8 days', now() - interval '8 days'),
    (today - 25, 'utilities', 2310.75, 'upi', 'Water cans', 30, 'Archived by mistake', acc, now() - interval '20 days', now() - interval '25 days', now() - interval '20 days');

  -- A stopped monthly series (shows the history; the job ignores inactive series).
  v_rec := gen_random_uuid();
  insert into public.expense_recurrences (id, category, amount, payment_mode, item, quantity, description, day_of_month, next_date, active, created_by, created_at, updated_at)
  values (v_rec, 'software', 499, 'card', 'Canva', 3, 'Design tool seats', 5, (date_trunc('month', today) + interval '1 month 4 days')::date, false, acc, now() - interval '400 days', now());
  update public.expenses set recurrence_id = v_rec where created_by = acc and item = 'Canva';

  -- Capital: founders and partners (name variants that group together), a loan, items received with nos, one archived.
  for i in 0 .. 13 loop
    v_date := (date_trunc('month', today) - make_interval(months => i))::date;
    insert into public.capital_entries (entry_date, contributor, amount, payment_mode, item, quantity, description, created_by, created_at, updated_at)
    values (v_date + 2, (array['Ansar', 'ansar ', 'ANSAR', 'Partner – Rahul'])[1 + i % 4], (array[100000, 50000, 75000, 25000])[1 + i % 4],
      case when i > 11 then null else (array['bank_transfer','upi','cheque','bank_transfer'])[1 + i % 4] end, null, null,
      'Monthly contribution', acc, v_date::timestamp + interval '11 hours', v_date::timestamp + interval '11 hours');
  end loop;
  insert into public.capital_entries (entry_date, contributor, amount, payment_mode, item, quantity, description, created_by, archived_at, created_at, updated_at) values
    (today - 300, 'Bank loan (SBI)', 500000, 'bank_transfer', null, null, 'Working capital loan', acc, null, now() - interval '300 days', now() - interval '300 days'),
    (today - 280, 'Ansar', 52000, 'upi', 'Chair', 8, 'Office chairs', acc, null, now() - interval '280 days', now() - interval '280 days'),
    (today - 279, 'Ansar', 36000, 'upi', 'Table', 4, null, acc, null, now() - interval '279 days', now() - interval '279 days'),
    (today - 200, 'Partner – Rahul', 165000, 'card', 'Laptop', 3, 'Sales team laptops', acc, null, now() - interval '200 days', now() - interval '200 days'),
    (today - 150, 'Partner – Rahul', 78000, 'cheque', 'Air conditioner', 2, null, acc, null, now() - interval '150 days', now() - interval '150 days'),
    (today - 90, 'Ansar', 13000, 'cash', 'chair', 2, 'Two more chairs (lowercase item groups with Chair)', acc, null, now() - interval '90 days', now() - interval '90 days'),
    (today - 30, 'Ansar', 4500, 'cash', 'Whiteboard', 1, null, acc, null, now() - interval '30 days', now() - interval '30 days'),
    (today - 10, 'Partner – Rahul', 0.01, 'upi', null, null, 'Smallest contribution', acc, null, now() - interval '10 days', now() - interval '10 days'),
    (today - 60, 'Test contributor', 99999, 'other', 'Sofa', 1, 'Archived entry (excluded from totals)', acc, now() - interval '59 days', now() - interval '60 days', now() - interval '59 days'),
    (today, 'Ansar', 20000, 'upi', 'Printer', 1, 'Added today', acc, null, now(), now());

  -- Finance history ("created", plus "archived" where archived) for every demo entry.
  insert into public.finance_activities (entity_type, entity_id, action, actor_id, changes, created_at)
  select 'expense', e.id, 'created', acc,
    to_jsonb(e) - array['id','created_by','updated_by','created_at','updated_at','archived_at','archived_by','recurrence_id'], e.created_at
  from public.expenses e where e.created_by = acc
  union all
  select 'capital', c.id, 'created', acc,
    to_jsonb(c) - array['id','created_by','updated_by','created_at','updated_at','archived_at','archived_by'], c.created_at
  from public.capital_entries c where c.created_by = acc;
  insert into public.finance_activities (entity_type, entity_id, action, actor_id, created_at)
  select 'expense', e.id, 'archived', acc, e.archived_at from public.expenses e where e.created_by = acc and e.archived_at is not null
  union all
  select 'capital', c.id, 'archived', acc, c.archived_at from public.capital_entries c where c.created_by = acc and c.archived_at is not null;
end $$;

set session_replication_role = origin;

select
  (select count(*) from public.leads l join public.profiles p on p.id = l.created_by where p.username like 'demo\_%') as leads,
  (select count(*) from public.follow_ups f join public.profiles p on p.id = f.created_by where p.username like 'demo\_%') as follow_ups,
  (select count(*) from public.lead_activities a join public.leads l on l.id = a.lead_id join public.profiles p on p.id = l.created_by where p.username like 'demo\_%') as activities,
  (select count(*) from public.expenses e join public.profiles p on p.id = e.created_by where p.username = 'demo_account') as expenses,
  (select count(*) from public.capital_entries c join public.profiles p on p.id = c.created_by where p.username = 'demo_account') as capital,
  (select count(*) from public.niches where name like 'Demo %') as niches;
