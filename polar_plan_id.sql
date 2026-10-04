update public.plan_prices
   set provider_product_id = case plan_id
 when 'individual' then 'f61a04bf-bb3b-41d6-887c-fca7b0111bb4'
       when 'pro'        then '67460390-7562-4369-a72c-4191d4185a82'
     end
 where provider = 'polar' and billing_interval = 'month';