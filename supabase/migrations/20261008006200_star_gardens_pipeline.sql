-- Star Gardens uses the same lead stages as Star Managed Farmlands:
--   New, Contacted, Interested, Not reachable, No answer, Proposal sent, Won, Lost.
--
-- Only the company named "Star Gardens", and only while it still has its old stages
-- (Inquiry, Pitch, Negotiation, On hold, Closed, Lost) — otherwise nothing changes.
-- Existing stages are renamed in place, so leads keep their stage and nothing is re-written:
--   Inquiry -> New, Pitch -> Contacted, Negotiation -> Interested, Closed -> Won.
-- "On hold" is archived (it must hold no leads); Not reachable, No answer and Proposal sent are added.
-- Old timeline entries keep the stage names they were written with.
do $$
declare
  v_company uuid;
begin
  select c.id into v_company from public.companies c where c.name = 'Star Gardens';
  if v_company is null then
    return;
  end if;
  if (select array_agg(s.name order by s.position, s.id) from public.pipeline_stages s
      where s.company_id = v_company and s.archived_at is null)
     is distinct from array['Inquiry', 'Pitch', 'Negotiation', 'On hold', 'Closed', 'Lost'] then
    return;
  end if;
  if exists (select 1 from public.leads l join public.pipeline_stages s on s.id = l.stage_id
             where s.company_id = v_company and s.name = 'On hold' and s.archived_at is null) then
    raise exception 'Star Gardens: "On hold" still has leads; move them first';
  end if;

  update public.pipeline_stages s set archived_at = now()
  where s.company_id = v_company and s.archived_at is null and s.name = 'On hold';

  update public.pipeline_stages s set
    name = m.new_name, position = m.pos, color = m.color
  from (values
    ('Inquiry', 'New', 1, 'slate'),
    ('Pitch', 'Contacted', 2, 'blue'),
    ('Negotiation', 'Interested', 3, 'violet'),
    ('Closed', 'Won', 7, 'emerald'),
    ('Lost', 'Lost', 8, 'red')
  ) as m(old_name, new_name, pos, color)
  where s.company_id = v_company and s.archived_at is null and s.name = m.old_name;

  insert into public.pipeline_stages (company_id, name, position, kind, color)
  values
    (v_company, 'Not reachable', 4, 'open', 'red'),
    (v_company, 'No answer', 5, 'open', 'red'),
    (v_company, 'Proposal sent', 6, 'open', 'amber');
end $$;
