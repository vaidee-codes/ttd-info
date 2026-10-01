-- The buyer's email now comes from Razorpay Checkout (captured payment), not our form.
alter table public.orders alter column email drop not null;
